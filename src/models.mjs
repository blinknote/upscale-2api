export const IMAGE_MODELS = [
  { id: 'flux-schnell', label: 'Flux Schnell', credits: 2, group: 'fast' },
  { id: 'hidream-l1-fast', label: 'HiDream L1 Fast', credits: 2, group: 'fast' },
  { id: 'z-image-turbo', label: 'Z-Image Turbo', credits: 2, group: 'fast' },
  { id: 'p-image', label: 'P-Image', credits: 2, group: 'fast' },
  { id: 'seedream-5-lite', label: 'Seedream 5 Lite', credits: 2, group: 'fast' },
  { id: 'flux-2-flex', label: 'Flux 2 Flex', credits: 5, group: 'standard' },
  { id: 'nano-banana', label: 'Nano Banana', credits: 8, group: 'standard' },
  { id: 'seedream-4.5', label: 'Seedream 4.5', credits: 7, group: 'standard' },
  { id: 'flux-2-pro', label: 'Flux 2 Pro', credits: 12, group: 'pro' },
  { id: 'imagen-4-ultra', label: 'Imagen 4 Ultra', credits: 12, group: 'pro' },
  { id: 'nano-banana-2', label: 'Nano Banana 2', credits: 9, group: 'pro' },
  { id: 'recraft-v4-svg', label: 'Recraft V4 SVG', credits: 6, group: 'pro' },
  { id: 'recraft-v4-pro', label: 'Recraft V4 Pro', credits: 10, group: 'pro' },
  { id: 'ideogram-v3-quality', label: 'Ideogram V3 Quality', credits: 9, group: 'pro' },
  { id: 'grok-imagine', label: 'Grok Imagine', credits: 11, group: 'pro' },
  { id: 'nano-banana-pro', label: 'Nano Banana Pro', credits: 25, group: 'flagship' },
  { id: 'flux-2-max', label: 'Flux 2 Max', credits: 20, group: 'flagship' },
  { id: 'gpt-image-1.5', label: 'GPT Image 1.5', credits: 12, group: 'flagship' },
  { id: 'gpt-image-2', label: 'GPT Image 2', credits: 12, group: 'flagship' },
  { id: 'gpt-image-2.6-flare', label: 'GPT Image 2.6 Flare', credits: 18, group: 'flagship' },
  { id: 'gpt-image-2.6-sunburst', label: 'GPT Image 2.6 Sunburst', credits: 25, group: 'flagship' },
];

export const MODEL_BY_ID = new Map(IMAGE_MODELS.map((m) => [m.id, m]));

export const ALIASES = {
  'dall-e-3': 'nano-banana-pro',
  'dall-e-2': 'nano-banana',
  'gpt-image-1': 'gpt-image-1.5',
  flux: 'flux-2-pro',
  'flux-pro': 'flux-2-pro',
  'flux-dev': 'flux-2-flex',
  seedream: 'seedream-4.5',
  imagen: 'imagen-4-ultra',
  ideogram: 'ideogram-v3-quality',
  'stable-diffusion': 'flux-2-pro',
  sd: 'flux-2-pro',
  midjourney: 'nano-banana-pro',
  mj: 'nano-banana-pro',
};

export const SIZES = {
  '256x256': '1:1',
  '512x512': '1:1',
  '1024x1024': '1:1',
  '1152x864': '4:3',
  '864x1152': '3:4',
  '1536x1024': '3:2',
  '1024x1536': '2:3',
  '1792x1024': '16:9',
  '1344x768': '16:9',
  '1024x1792': '9:16',
  '768x1344': '9:16',
};

export const ASPECTS = ['1:1', '4:5', '3:4', '16:9', '3:2', '9:16', '2:3', '4:3'];

export function resolveModel(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (MODEL_BY_ID.has(s)) return s;
  const low = s.toLowerCase();
  if (MODEL_BY_ID.has(low)) return low;
  if (ALIASES[low]) return ALIASES[low];
  return null;
}

export function sizeToAspect(size, fallback = '1:1') {
  if (!size) return fallback;
  if (ASPECTS.includes(size)) return size;
  return SIZES[String(size).toLowerCase()] ?? fallback;
}

export function creditsFor(modelId, n = 1) {
  const m = MODEL_BY_ID.get(modelId);
  return (m?.credits ?? 8) * Math.max(1, n);
}

export const UPSCALE_ENGINES = {
  'upscale-image': { credits: 1, fields: 'factor,removeBackground' },
  'topaz-upscale': { credits: 3, fields: 'upscaleFactor,faceEnhancement,outputFormat' },
  'pruna-upscale': { credits: 2, fields: 'upscaleMode,factor,target,outputFormat,enhanceDetails,enhanceRealism' },
  'recraft-upscale': { credits: 2, fields: 'factor,outputFormat' },
  'clarity-upscale': { credits: 2, fields: 'factor' },
  'crystal-upscale': { credits: 2, fields: 'factor' },
  'google-upscale': { credits: 2, fields: 'factor' },
  'recraft-crisp-upscale': { credits: 2, fields: 'factor' },
  'resrgan-lite': { credits: 1, fields: 'factor' },
  'swin2sr': { credits: 1, fields: 'factor' },
  'swinir-denoise': { credits: 1, fields: 'factor' },
  'gfpgan-restore': { credits: 2, fields: 'factor' },
  'remove-background': { credits: 1, fields: '' },
  'remove-logo-bg': { credits: 1, fields: '' },
};
