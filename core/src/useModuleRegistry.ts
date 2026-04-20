import { useEffect, useState } from "react";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { useAwsDdbClient, useTableNames } from "./hooks.ts";
import type { ModulePickerGroup, ModuleRegistryEntry } from "./types.ts";

const GROUP_ORDER: Record<ModulePickerGroup, number> = {
  Documentation: 0,
  Productivity: 1,
  Navigation: 2,
  Tools: 3,
  Other: 4,
};

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
          .filter((entry) => !entry.pickerHidden)
          .map((entry) => ({
            ...entry,
            category: entry.category === "app" ? "component" : (entry.category ?? "component"),
            pickerGroup: entry.pickerGroup ?? "Other",
          }));

        items.sort((a, b) => {
          const ao = a.category === "layout" ? 0 : 1;
          const bo = b.category === "layout" ? 0 : 1;
          if (ao !== bo) return ao - bo;
          if (a.category !== "layout" && b.category !== "layout") {
            const ag = GROUP_ORDER[a.pickerGroup ?? "Other"] ?? GROUP_ORDER.Other;
            const bg = GROUP_ORDER[b.pickerGroup ?? "Other"] ?? GROUP_ORDER.Other;
            if (ag !== bg) return ag - bg;
          }
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
