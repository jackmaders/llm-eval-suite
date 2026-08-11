// Optional, opt-in check (--check-remote-quants) for whether a quantization
// this suite would recommend switching to is already downloaded, or needs
// fetching. LM Studio's own `lms get` has no non-interactive/JSON listing
// mode (verified against its docs), so this queries Hugging Face's public
// model API directly using the repo id recovered from discovery (see
// config.ts's parseHfRepoFromIdentifier) — best-effort throughout, since a
// model not hosted on HF, a renamed repo, or a network hiccup should never
// break anything else in the pipeline.

import { extractQuant } from "./config";
import type { DownloadRecommendationCheck, ModelConfig } from "./types";

/** Fetches every `.gguf` file listed for a Hugging Face repo and extracts its quant token. */
export async function fetchAvailableQuants(repoId: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const response = await fetchImpl(`https://huggingface.co/api/models/${repoId}`);
  if (!response.ok) {
    throw new Error(`Hugging Face API request for "${repoId}" failed with status ${response.status}`);
  }

  const data = (await response.json()) as { siblings?: Array<{ rfilename?: string }> };
  const quants = new Set<string>();
  for (const sibling of data.siblings ?? []) {
    const fileName = sibling.rfilename;
    if (!fileName || !fileName.toLowerCase().endsWith(".gguf")) continue;
    const quant = extractQuant(fileName);
    if (quant !== "unknown") quants.add(quant);
  }
  return [...quants];
}

/**
 * Given a quant this suite would recommend switching to (from
 * recommendQuantChange in recommendation.ts), checks whether it's already
 * downloaded locally or needs fetching from Hugging Face. Returns undefined
 * whenever there's nothing to check or the check can't be completed — no
 * recommendation, no resolvable HF repo, or the HF lookup itself fails —
 * since this is an optional extra, never something the pipeline depends on.
 */
export async function checkDownloadRecommendation(
  model: ModelConfig,
  recommendedQuant: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadRecommendationCheck | undefined> {
  if (!recommendedQuant || !model.hfRepoId) return undefined;

  let availableQuants: string[];
  try {
    availableQuants = await fetchAvailableQuants(model.hfRepoId, fetchImpl);
  } catch {
    return undefined;
  }

  const normalizedRecommended = recommendedQuant.toUpperCase();
  const locallyAvailable = new Set((model.locallyAvailableQuants ?? [model.quant]).map((q) => q.toUpperCase()));
  const recommendedQuantAlreadyLocal = locallyAvailable.has(normalizedRecommended);
  const recommendedQuantDownloadable =
    !recommendedQuantAlreadyLocal && availableQuants.some((q) => q.toUpperCase() === normalizedRecommended);

  return {
    repoId: model.hfRepoId,
    availableQuants,
    recommendedQuantAlreadyLocal,
    recommendedQuantDownloadable,
  };
}
