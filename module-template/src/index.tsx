import React from "react";
import type { ModuleProps, ExportContext } from "module-core";
import {
  useUserProfile,
  useAwsS3Client,
  useAwsDdbClient,
  useResource,
  useEditMode,
  SlotContainer,
} from "module-core";

/**
 * module-template — starter template for building a new module.
 *
 * Copy this package, rename it, and implement your component.
 *
 * BUILDING & DEPLOYING
 * --------------------
 * 1. `npm run build` — produces dist/bundle.js
 * 2. Upload dist/bundle.js to your S3 bucket
 * 3. Write a config.json alongside it:
 *
 *    {
 *      "id": "my-module",
 *      "app": { "bucket": "my-bucket", "key": "modules/my-module/bundle.js" },
 *      "meta": { "title": "My Module" },
 *      "resources": [
 *        { "id": "my-module/data-file", "label": "Data File", "type": "s3-object",
 *          "bucket": "my-bucket", "key": "data/file.csv", "mimeType": "text/csv" }
 *      ],
 *      "children": [
 *        { "slotName": "content", "configPath": "modules/child/config.json" }
 *      ]
 *    }
 *
 * 4. Point the shell at your config: ?bucket=my-bucket&config=modules/my-module/config.json
 *
 * AVAILABLE HOOKS (from module-core)
 * -----------------------------------
 * useUserProfile()     — authenticated user's email, name, picture
 * useAwsS3Client()     — async factory → pre-configured S3Client
 * useAwsDdbClient()    — async factory → pre-configured DynamoDBDocumentClient
 * useResource(id)      — look up any declared Resource by id
 * useEditMode()        — { editMode: boolean, setEditMode }
 * <SlotContainer>      — render a named child slot recursively
 */
export default function TemplateModule({ config }: ModuleProps) {
  const userProfile = useUserProfile();
  const getS3Client = useAwsS3Client();
  const getDdbClient = useAwsDdbClient();
  const { editMode } = useEditMode();

  // Example: look up a declared resource by id
  const dataResource = useResource(`${config.id}/data-file`);

  // Silence unused warnings until you implement your module
  void getS3Client;
  void getDdbClient;
  void dataResource;

  // Read module-specific settings from config.meta
  const title = (config.meta?.["title"] as string | undefined) ?? config.id;

  return (
    <div style={{ padding: "1rem", fontFamily: "system-ui, sans-serif" }}>
      <h2>{title}</h2>

      {userProfile && (
        <p style={{ fontSize: "0.85rem", color: "#6b7280" }}>
          Viewing as {userProfile.email}
        </p>
      )}

      {editMode && (
        <p style={{ fontSize: "0.8rem", color: "#3b82f6" }}>
          Edit mode active — slot overlays are visible below.
        </p>
      )}

      {/* Render child slots declared in config.children */}
      {config.children?.map((slot) => (
        <SlotContainer
          key={slot.slotName}
          slot={slot}
          parentBucket={config.app.bucket}
        />
      ))}
    </div>
  );
}

/**
 * onExport — optional. Implement this if your module fetches data from
 * non-S3 sources that need to be included in a project export/archive.
 *
 * The shell calls this before zipping the project's S3 prefix.
 * Write any external data into S3 under ctx.projectPrefix + config.id + "/export/".
 */
export async function onExport(_ctx: ExportContext): Promise<void> {
  // Example:
  // const data = await fetchFromExternalApi();
  // await ctx.s3Client.send(new PutObjectCommand({
  //   Bucket: "my-bucket",
  //   Key: `${ctx.projectPrefix}${_ctx.config.id}/export/data.json`,
  //   Body: JSON.stringify(data),
  // }));
}
