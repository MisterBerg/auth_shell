import { useEffect, useState } from "react";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { useAwsDdbClient, useTableNames } from "./hooks.ts";
import type { ModuleRegistryEntry } from "./types.ts";

/**
 * Queries the module registry for all published modules (latest versions only).
 * Returns entries grouped by category for use in the module picker.
 */
export function useModuleRegistry() {
  const getDdbClient = useAwsDdbClient();
  const { registry: registryTable } = useTableNames();

  const [entries, setEntries] = useState<ModuleRegistryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    getDdbClient()
      .then((ddb) =>
        ddb.send(new ScanCommand({
          TableName: registryTable,
          // Only fetch the "latest" pointer records — one per module
          FilterExpression: "#v = :latest",
          ExpressionAttributeNames: { "#v": "version" },
          ExpressionAttributeValues: { ":latest": "latest" },
        }))
      )
      .then((result) => {
        if (cancelled) return;
        const items = ((result.Items ?? []) as ModuleRegistryEntry[])
          .filter((entry) => !entry.pickerHidden);
        // Sort: layouts first, then apps, then components, then uncategorized
        const order: Record<string, number> = { layout: 0, app: 1, component: 2 };
        items.sort((a, b) => {
          const ao = order[a.category ?? ""] ?? 3;
          const bo = order[b.category ?? ""] ?? 3;
          if (ao !== bo) return ao - bo;
          return (a.displayName ?? a.moduleName).localeCompare(b.displayName ?? b.moduleName);
        });
        setEntries(items);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError((err as Error).message);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [getDdbClient]);

  return { entries, loading, error };
}
