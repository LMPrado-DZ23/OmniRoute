// endpointTypes.ts — shapes shared between the endpoint page and its sub-components:
// the provider / model summaries rendered by the endpoint cards and the provider
// models modal, plus the copy-to-clipboard handler they receive from the page.
// Extracted verbatim from EndpointPageClient.tsx (file-size ratchet).

export type EndpointProviderSummary = {
  id: string;
  provider: {
    name: string;
    alias?: string;
  };
};

export type EndpointModelSummary = {
  id: string;
  owned_by?: string;
  parent?: string;
  type?: string;
  custom?: boolean;
  root?: string;
};

// Callers ignore the result; useCopyToClipboard's `copy` resolves to whether the write succeeded.
export type CopyHandler = (text: string, key?: string) => void | Promise<unknown>;
