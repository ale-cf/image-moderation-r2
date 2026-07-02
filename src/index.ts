/**
 * Image Moderation + Transform + R2 pipeline
 *
 * Flow:
 *  1. UI (public/index.html) drag & drops an image and POSTs it to /api/process.
 *  2. The image is analyzed for NSFW / unsafe content using a Workers AI vision model.
 *  3. If safe, 4 transformations are generated via the Images binding.
 *  4. Each transformation is uploaded to R2.
 *  5. URLs pointing at the R2 custom domain are returned to the client.
 */

interface Env {
  AI: Ai;
  IMAGES: ImagesBinding;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  R2_PUBLIC_URL: string;
  MODERATION_MODEL: string;
}

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // Images binding accepts up to 20MB

type OutputFormat = "image/webp" | "image/avif" | "image/jpeg";

interface TransformSpec {
  name: string;
  ext: string;
  format: OutputFormat;
  quality: number;
  transforms: ImageTransform[];
}

/** The 4 transformations generated for every safe upload. */
const TRANSFORMS: TransformSpec[] = [
  {
    name: "thumbnail",
    ext: "webp",
    format: "image/webp",
    quality: 80,
    transforms: [{ width: 320, height: 320, fit: "cover" }],
  },
  {
    name: "wide",
    ext: "webp",
    format: "image/webp",
    quality: 82,
    transforms: [{ width: 1280, fit: "scale-down" }],
  },
  {
    name: "placeholder",
    ext: "webp",
    format: "image/webp",
    quality: 60,
    transforms: [{ width: 64 }, { blur: 40 }],
  },
  {
    name: "vintage",
    ext: "jpg",
    format: "image/jpeg",
    quality: 85,
    transforms: [{ width: 800, brightness: 1.1, contrast: 1.1, gamma: 0.9 }],
  },
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/process" && request.method === "POST") {
      return handleProcess(request, env, ctx);
    }

    // Everything else is served by the static assets (the UI).
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleProcess(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected multipart/form-data upload." }, 400);
  }

  // Runtime returns a File for uploaded blobs; the type says string, so cast.
  const file = form.get("image") as unknown as File | null;
  if (!(file instanceof File)) {
    return json({ error: "Missing 'image' field." }, 400);
  }
  if (!file.type.startsWith("image/")) {
    return json({ error: `Unsupported file type: ${file.type || "unknown"}.` }, 415);
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return json(
      { error: `Image too large (${humanSize(file.size)}). Max is ${humanSize(MAX_UPLOAD_BYTES)}.` },
      413,
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  // 1. Moderate.
  let moderation: ModerationResult;
  try {
    moderation = await moderateImage(bytes, env);
  } catch (err) {
    console.error("Moderation failed:", err);
    return json({ error: "Content moderation failed. Please try again." }, 502);
  }

  if (!moderation.safe) {
    return json(
      {
        safe: false,
        moderation,
        error: "Image rejected by content moderation.",
      },
      422,
    );
  }

  // 2. Transform + 3. Upload to R2.
  const id = crypto.randomUUID();
  let variants: VariantResult[];
  try {
    variants = await transformAndStore(bytes, id, env);
  } catch (err) {
    console.error("Transform/upload failed:", err);
    return json({ error: "Image processing failed. Please try again." }, 500);
  }

  // Best-effort: keep the cache warm is not needed here; nothing to defer.
  void ctx;

  return json({
    safe: true,
    id,
    moderation,
    variants,
  });
}

/* -------------------------------------------------------------------------- */
/* Moderation                                                                 */
/* -------------------------------------------------------------------------- */

interface ModerationResult {
  safe: boolean;
  rating: "SAFE" | "UNSAFE" | "UNKNOWN";
  reason: string;
  model: string;
  raw: string;
}

const MODERATION_PROMPT = [
  "You are an image content-safety classifier for a general audience.",
  "Examine the image and classify it against these UNSAFE categories:",
  "nudity or partial nudity, sexual or suggestive content, pornography,",
  "graphic violence, gore, self-harm, or other explicit/adult material.",
  "",
  "Answer with the first line being EXACTLY one of:",
  "VERDICT: SAFE",
  "VERDICT: UNSAFE",
  "Then a second line: REASON: <one short sentence>.",
  "If you are unsure or cannot clearly determine the content, answer VERDICT: UNSAFE.",
].join("\n");

async function moderateImage(bytes: Uint8Array, env: Env): Promise<ModerationResult> {
  const model = env.MODERATION_MODEL || "@cf/meta/llama-3.2-11b-vision-instruct";

  const response = (await env.AI.run(model as keyof AiModels, {
    image: [...bytes],
    prompt: MODERATION_PROMPT,
    max_tokens: 256,
    temperature: 0.1,
  } as never)) as { response?: string; description?: string };

  const raw = (response?.response ?? response?.description ?? "").trim();
  const upper = raw.toUpperCase();

  // Parse the explicit verdict token; anything else fails closed to UNSAFE.
  let rating: ModerationResult["rating"];
  const verdict = upper.match(/VERDICT:\s*(SAFE|UNSAFE)/);
  if (verdict) {
    rating = verdict[1] as "SAFE" | "UNSAFE";
  } else if (/\bUNSAFE\b|\bNSFW\b|\bNOT SAFE\b|\bEXPLICIT\b|\bNUD(E|ITY)\b|\bPORN/.test(upper)) {
    rating = "UNSAFE";
  } else if (/^\s*SAFE\b/.test(upper) || /\bIS SAFE\b|\bVERDICT SAFE\b/.test(upper)) {
    rating = "SAFE";
  } else {
    rating = "UNKNOWN";
  }

  // Fail closed: only an explicit SAFE verdict is allowed through.
  const safe = rating === "SAFE";

  return {
    safe,
    rating,
    reason: raw || "No response from moderation model.",
    model,
    raw,
  };
}

/* -------------------------------------------------------------------------- */
/* Transform + store                                                          */
/* -------------------------------------------------------------------------- */

interface VariantResult {
  name: string;
  key: string;
  url: string;
  contentType: OutputFormat;
}

async function transformAndStore(
  bytes: Uint8Array,
  id: string,
  env: Env,
): Promise<VariantResult[]> {
  const base = env.R2_PUBLIC_URL.replace(/\/+$/, "");

  return Promise.all(
    TRANSFORMS.map(async (spec) => {
      // A ReadableStream can only be consumed once, so build a fresh one per variant.
      let pipeline = env.IMAGES.input(bytesToStream(bytes));
      for (const t of spec.transforms) {
        pipeline = pipeline.transform(t);
      }
      const result = await pipeline.output({
        format: spec.format,
        quality: spec.quality,
      });

      const key = `${id}/${spec.name}.${spec.ext}`;
      await env.BUCKET.put(key, result.response().body, {
        httpMetadata: {
          contentType: spec.format,
          cacheControl: "public, max-age=31536000, immutable",
        },
        customMetadata: { sourceId: id, variant: spec.name },
      });

      return {
        name: spec.name,
        key,
        url: `${base}/${key}`,
        contentType: spec.format,
      };
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Blob([bytes]).stream();
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
