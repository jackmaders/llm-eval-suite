import { describe, expect, test } from "bun:test";
import { checkDownloadRecommendation, fetchAvailableQuants } from "../src/remoteQuants";
import type { ModelConfig } from "../src/types";

function hfResponse(rfilenames: string[]): Response {
  return new Response(JSON.stringify({ siblings: rfilenames.map((rfilename) => ({ rfilename })) }), { status: 200 });
}

describe("fetchAvailableQuants", () => {
  test("extracts quant tokens from every .gguf sibling file", async () => {
    const fetchImpl = (async () =>
      hfResponse([
        ".gitattributes",
        "README.md",
        "Magistral-Small-2509-Q4_K_M.gguf",
        "Magistral-Small-2509-Q6_K.gguf",
        "Magistral-Small-2509-Q8_0.gguf",
      ])) as unknown as typeof fetch;

    const quants = await fetchAvailableQuants("lmstudio-community/Magistral-Small-2509-GGUF", fetchImpl);
    expect(quants).toEqual(["Q4_K_M", "Q6_K", "Q8_0"]);
  });

  test("requests the correct Hugging Face API URL", async () => {
    let requestedUrl: string | undefined;
    const fetchImpl = (async (url: string) => {
      requestedUrl = url;
      return hfResponse([]);
    }) as unknown as typeof fetch;

    await fetchAvailableQuants("some/repo", fetchImpl);
    expect(requestedUrl).toBe("https://huggingface.co/api/models/some/repo");
  });

  test("throws when the repo isn't found", async () => {
    const fetchImpl = (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
    await expect(fetchAvailableQuants("nonexistent/repo", fetchImpl)).rejects.toThrow(/404/);
  });

  test("returns an empty list when a repo has no .gguf files", async () => {
    const fetchImpl = (async () => hfResponse(["README.md", "config.json"])) as unknown as typeof fetch;
    expect(await fetchAvailableQuants("some/repo", fetchImpl)).toEqual([]);
  });

  test("deduplicates repeated quant tokens across multiple files", async () => {
    const fetchImpl = (async () =>
      hfResponse(["model-Q4_K_M.gguf", "model-00001-of-00002-Q4_K_M.gguf"])) as unknown as typeof fetch;
    expect(await fetchAvailableQuants("some/repo", fetchImpl)).toEqual(["Q4_K_M"]);
  });
});

describe("checkDownloadRecommendation", () => {
  const model: ModelConfig = {
    modelKey: "mistralai/magistral-small-2509",
    quant: "Q4_K_M",
    locallyAvailableQuants: ["Q4_K_M"],
    hfRepoId: "lmstudio-community/Magistral-Small-2509-GGUF",
  };

  test("flags the recommended quant as downloadable when it's on HF but not local", async () => {
    const fetchImpl = (async () =>
      hfResponse(["m-Q4_K_M.gguf", "m-Q6_K.gguf", "m-Q8_0.gguf"])) as unknown as typeof fetch;

    const result = await checkDownloadRecommendation(model, "Q6_K", fetchImpl);
    expect(result).toEqual({
      repoId: "lmstudio-community/Magistral-Small-2509-GGUF",
      availableQuants: ["Q4_K_M", "Q6_K", "Q8_0"],
      recommendedQuantAlreadyLocal: false,
      recommendedQuantDownloadable: true,
    });
  });

  test("reports the recommended quant as already local when it's already downloaded", async () => {
    const withBoth: ModelConfig = { ...model, locallyAvailableQuants: ["Q4_K_M", "Q6_K"] };
    const fetchImpl = (async () => hfResponse(["m-Q4_K_M.gguf", "m-Q6_K.gguf"])) as unknown as typeof fetch;

    const result = await checkDownloadRecommendation(withBoth, "Q6_K", fetchImpl);
    expect(result?.recommendedQuantAlreadyLocal).toBe(true);
    expect(result?.recommendedQuantDownloadable).toBe(false);
  });

  test("reports not downloadable when the recommended quant isn't published on HF either", async () => {
    const fetchImpl = (async () => hfResponse(["m-Q4_K_M.gguf"])) as unknown as typeof fetch;
    const result = await checkDownloadRecommendation(model, "Q3_K_S", fetchImpl);
    expect(result?.recommendedQuantAlreadyLocal).toBe(false);
    expect(result?.recommendedQuantDownloadable).toBe(false);
  });

  test("returns undefined when the model has no resolvable hfRepoId", async () => {
    const noRepo: ModelConfig = { modelKey: "custom/local-import", quant: "Q4_K_M" };
    const fetchImpl = (async () => hfResponse([])) as unknown as typeof fetch;
    expect(await checkDownloadRecommendation(noRepo, "Q6_K", fetchImpl)).toBeUndefined();
  });

  test("returns undefined when there is no recommended quant to check", async () => {
    const fetchImpl = (async () => hfResponse([])) as unknown as typeof fetch;
    expect(await checkDownloadRecommendation(model, undefined, fetchImpl)).toBeUndefined();
  });

  test("returns undefined (rather than throwing) when the Hugging Face lookup fails", async () => {
    // Best-effort: a model not on HF, a network hiccup, or a renamed repo
    // shouldn't break Phase 3 or the report — this is an optional extra, not
    // something the pipeline depends on.
    const fetchImpl = (async () => new Response("Not Found", { status: 404 })) as unknown as typeof fetch;
    expect(await checkDownloadRecommendation(model, "Q6_K", fetchImpl)).toBeUndefined();
  });
});
