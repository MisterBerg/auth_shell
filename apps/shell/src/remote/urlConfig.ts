/**
 * Parses URL parameters to extract a module config location.
 *
 * Expected format:  ?bucket=my-org-apps&config=apps/my-app/config.json
 *
 * The `bucket` param is the S3 bucket and `config` is the S3 key for the
 * root config.json of the module to load.  Both bucket and key come from the
 * URL so that users can host modules in their own S3 buckets.
 *
 * Returns null when params are absent — the shell interprets this as "load
 * the default org landing page" rather than an error.
 */
export type UrlModuleLocation = {
  bucket: string;
  configPath: string;
};

export function getModuleLocationFromUrl(): UrlModuleLocation | null {
  const params = new URLSearchParams(window.location.search);

  const bucket = params.get("bucket");
  const configPath = params.get("config");

  if (!bucket || !configPath) return null;

  return { bucket, configPath };
}
