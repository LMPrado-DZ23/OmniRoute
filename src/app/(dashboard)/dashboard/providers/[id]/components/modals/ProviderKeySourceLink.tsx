"use client";

// One click from "Add API key" to where that key actually comes from.
//
// Asking for a credential without saying where to get it sends the user to a
// search engine. The provider catalog already knows: `notice.apiKeyUrl` is the
// exact page that mints the key, and `website` is the provider's site. This
// renders whichever of the two exists — never a URL composed here — and the
// copy names which one it is, so a homepage is never presented as a key page.
//
// Same resolution order as ProviderPageHeader's "Get API key" link (#9270),
// applied to the dialog where the user is actually holding the credential.
import { resolveStaticProviderCatalogEntry } from "@/lib/providers/catalog";
import { providerText, type ProviderMessageTranslator } from "../../providerPageHelpers";

export interface ProviderKeySourceTarget {
  /** Absolute https URL, verbatim from the catalog. */
  url: string;
  /** Host of `url`, shown in the copy so the destination is visible before the click. */
  host: string;
  /** True for `notice.apiKeyUrl` (the key page), false for `website` (the provider site). */
  isKeyPage: boolean;
}

/**
 * Resolves the catalog's best "where do I get this key" URL for `providerId`,
 * or null when there is none to offer.
 *
 * Only `https:` survives. The catalog is curated, but this renders a live
 * navigation target next to a credential field, so the scheme is checked here
 * rather than assumed: `javascript:` would execute in the page, and plain
 * `http:` would walk the user to an API console over a cleartext hop.
 */
export function resolveProviderKeySourceTarget(
  providerId?: string | null
): ProviderKeySourceTarget | null {
  if (!providerId) return null;
  const entry = resolveStaticProviderCatalogEntry(providerId);
  if (!entry) return null;
  const apiKeyUrl = entry.notice?.apiKeyUrl?.trim();
  const source = apiKeyUrl || entry.website?.trim();
  if (!source) return null;
  try {
    const parsed = new URL(source);
    if (parsed.protocol !== "https:") return null;
    return { url: source, host: parsed.host, isKeyPage: !!apiKeyUrl };
  } catch {
    return null;
  }
}

interface ProviderKeySourceLinkProps {
  providerId?: string | null;
  t: ProviderMessageTranslator;
}

export default function ProviderKeySourceLink({ providerId, t }: ProviderKeySourceLinkProps) {
  const target = resolveProviderKeySourceTarget(providerId);
  if (!target) return null;

  const label = target.isKeyPage
    ? providerText(t, "getApiKeyAtHost", "Get your API key at {host}", { host: target.host })
    : providerText(t, "openProviderSiteForApiKey", "Open {host} to find your API key", {
        host: target.host,
      });

  // Full-strength text-primary: that token is tuned to clear WCAG AA 4.5:1 in both
  // themes, and any opacity on top of it drops the link below AA (axe color-contrast).
  return (
    <a
      data-testid="provider-key-source-link"
      href={target.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
    >
      <span className="material-symbols-outlined text-base" aria-hidden="true">
        open_in_new
      </span>
      {label}
    </a>
  );
}
