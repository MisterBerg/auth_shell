/**
 * provision-aws.ts
 *
 * One-time setup: creates all AWS resources needed for Jeffspace.
 *
 *   S3 buckets:
 *     jeffspace-modules   — project configs and user content (direct browser access via Cognito)
 *     jeffspace-registry  — published module bundles (direct browser access via Cognito)
 *     jeffspace-shell     — built shell SPA, served via CloudFront (private, OAC)
 *
 *   DynamoDB tables:
 *     jeffspace-projects         — userId (PK) + projectId (SK) + shared GSI
 *     jeffspace-module-registry  — moduleName (PK) + version (SK)
 *     jeffspace-projects-locks   — projectId (PK)
 *
 *   CloudFront:
 *     distribution → jeffspace-shell (OAC, HTTPS, SPA error routing)
 *
 *   IAM:
 *     inline policy on the Cognito authenticated role granting access to the above
 *
 * Reads credentials from .aws/credentials/access_key in the project root.
 * Safe to re-run — skips resources that already exist.
 *
 * Usage:
 *   npx tsx scripts/provision-aws.ts
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

import {
  S3Client,
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketPolicyCommand,
  PutBucketWebsiteCommand,
  HeadBucketCommand,
  PutPublicAccessBlockCommand,
} from "@aws-sdk/client-s3";
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  CloudFrontClient,
  CreateDistributionCommand,
  CreateOriginAccessControlCommand,
  ListOriginAccessControlsCommand,
} from "@aws-sdk/client-cloudfront";
import {
  IAMClient,
  PutRolePolicyCommand,
  GetRoleCommand,
  ListAttachedRolePoliciesCommand,
} from "@aws-sdk/client-iam";
import {
  CognitoIdentityClient,
  GetIdentityPoolRolesCommand,
} from "@aws-sdk/client-cognito-identity";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const REGION = "us-east-2";
const IDENTITY_POOL_ID = "us-east-2:56ea9e92-144b-4c7c-993a-efc40288f4c2";

const BUCKETS = {
  modules:  "jeffspace-modules",
  registry: "jeffspace-registry",
  shell:    "jeffspace-shell",
};

const TABLES = {
  projects: "jeffspace-projects",
  registry: "jeffspace-module-registry",
  locks:    "jeffspace-projects-locks",
};

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

function loadCredentials(): { accessKeyId: string; secretAccessKey: string } {
  const credFile = join(ROOT, ".aws", "credentials", "access_key");
  const lines = readFileSync(credFile, "utf-8").trim().split(/\r?\n/);
  const accessKeyId = lines[0]?.trim();
  const secretAccessKey = lines[1]?.trim();
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(`Could not parse credentials from ${credFile}`);
  }
  return { accessKeyId, secretAccessKey };
}

const credentials = loadCredentials();

const s3  = new S3Client({ region: REGION, credentials });
const ddb = new DynamoDBClient({ region: REGION, credentials });
const cf  = new CloudFrontClient({ region: "us-east-1", credentials }); // CloudFront is global, uses us-east-1
const iam = new IAMClient({ region: REGION, credentials });
const cognito = new CognitoIdentityClient({ region: REGION, credentials });
const sts = new STSClient({ region: REGION, credentials });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(msg: string)   { console.log(`  ✓ ${msg}`); }
function skip(msg: string) { console.log(`  · ${msg}`); }
function info(msg: string) { console.log(`  ℹ ${msg}`); }

async function getAccountId(): Promise<string> {
  const res = await sts.send(new GetCallerIdentityCommand({}));
  return res.Account!;
}

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

async function bucketExists(bucket: string): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

async function ensureBucket(bucket: string): Promise<void> {
  if (await bucketExists(bucket)) {
    skip(`bucket "${bucket}" already exists`);
    return;
  }
  await s3.send(new CreateBucketCommand({
    Bucket: bucket,
    CreateBucketConfiguration: { LocationConstraint: REGION },
  }));
  ok(`bucket "${bucket}" created`);
}

async function configureDataBucketCors(bucket: string): Promise<void> {
  await s3.send(new PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: ["http://localhost:5173", "https://*.cloudfront.net"],
        AllowedMethods: ["GET", "PUT", "DELETE", "HEAD"],
        AllowedHeaders: ["*"],
        ExposeHeaders: ["ETag"],
        MaxAgeSeconds: 3600,
      }],
    },
  }));
  ok(`CORS configured on "${bucket}"`);
}

async function blockPublicAccess(bucket: string): Promise<void> {
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: bucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  }));
  ok(`public access blocked on "${bucket}"`);
}

// ---------------------------------------------------------------------------
// DynamoDB
// ---------------------------------------------------------------------------

async function tableExists(name: string): Promise<boolean> {
  try {
    await ddb.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch {
    return false;
  }
}

async function ensureProjectsTable(): Promise<void> {
  if (await tableExists(TABLES.projects)) {
    skip(`table "${TABLES.projects}" already exists`);
    return;
  }
  await ddb.send(new CreateTableCommand({
    TableName: TABLES.projects,
    AttributeDefinitions: [
      { AttributeName: "userId",          AttributeType: "S" },
      { AttributeName: "projectId",       AttributeType: "S" },
      { AttributeName: "sharedWithUserId", AttributeType: "S" },
      { AttributeName: "updatedAt",       AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "userId",    KeyType: "HASH" },
      { AttributeName: "projectId", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [{
      IndexName: "sharedWithUserId-updatedAt-index",
      KeySchema: [
        { AttributeName: "sharedWithUserId", KeyType: "HASH" },
        { AttributeName: "updatedAt",        KeyType: "RANGE" },
      ],
      Projection: { ProjectionType: "ALL" },
    }],
    BillingMode: "PAY_PER_REQUEST",
  }));
  ok(`table "${TABLES.projects}" created`);
}

async function ensureSimpleTable(name: string, pk: string, sk?: string): Promise<void> {
  if (await tableExists(name)) {
    skip(`table "${name}" already exists`);
    return;
  }
  await ddb.send(new CreateTableCommand({
    TableName: name,
    AttributeDefinitions: [
      { AttributeName: pk, AttributeType: "S" },
      ...(sk ? [{ AttributeName: sk, AttributeType: "S" }] : []),
    ],
    KeySchema: [
      { AttributeName: pk, KeyType: "HASH" },
      ...(sk ? [{ AttributeName: sk, KeyType: "RANGE" }] : []),
    ],
    BillingMode: "PAY_PER_REQUEST",
  }));
  ok(`table "${name}" created`);
}

// ---------------------------------------------------------------------------
// IAM — attach policy to Cognito authenticated role
// ---------------------------------------------------------------------------

async function updateCognitoRolePolicy(accountId: string): Promise<void> {
  let authenticatedRoleArn: string;
  try {
    const poolRoles = await cognito.send(
      new GetIdentityPoolRolesCommand({ IdentityPoolId: IDENTITY_POOL_ID })
    );
    authenticatedRoleArn = poolRoles.Roles?.["authenticated"] ?? "";
    if (!authenticatedRoleArn) throw new Error("No authenticated role found on identity pool");
  } catch (err) {
    console.warn(`  ⚠ Could not read Cognito identity pool roles: ${(err as Error).message}`);
    console.warn(`    Apply the following inline policy manually to the authenticated IAM role:`);
    printManualPolicy(accountId);
    return;
  }

  const roleName = authenticatedRoleArn.split("/").pop()!;
  const policy = buildRolePolicy(accountId);

  try {
    await iam.send(new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: "JeffspaceAccess",
      PolicyDocument: JSON.stringify(policy, null, 2),
    }));
    ok(`inline policy "JeffspaceAccess" applied to role "${roleName}"`);
  } catch (err) {
    console.warn(`  ⚠ Could not update IAM role: ${(err as Error).message}`);
    console.warn(`    Apply the following inline policy manually to role "${roleName}":`);
    printManualPolicy(accountId);
  }
}

function buildRolePolicy(accountId: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "JeffspaceS3Access",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:HeadObject"],
        Resource: [
          `arn:aws:s3:::${BUCKETS.modules}/*`,
          `arn:aws:s3:::${BUCKETS.registry}/*`,
        ],
      },
      {
        Sid: "JeffspaceS3List",
        Effect: "Allow",
        Action: ["s3:ListBucket"],
        Resource: [
          `arn:aws:s3:::${BUCKETS.modules}`,
          `arn:aws:s3:::${BUCKETS.registry}`,
        ],
      },
      {
        Sid: "JeffspaceDynamoAccess",
        Effect: "Allow",
        Action: [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
          "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
        ],
        Resource: [
          `arn:aws:dynamodb:${REGION}:${accountId}:table/jeffspace-*`,
          `arn:aws:dynamodb:${REGION}:${accountId}:table/jeffspace-*/index/*`,
        ],
      },
    ],
  };
}

function printManualPolicy(accountId: string): void {
  console.log(JSON.stringify(buildRolePolicy(accountId), null, 2));
}

// ---------------------------------------------------------------------------
// CloudFront — OAC distribution for the shell bucket
// ---------------------------------------------------------------------------

async function createShellDistribution(accountId: string): Promise<string> {
  // Create or reuse Origin Access Control
  let oacId: string;
  const OAC_NAME = "jeffspace-shell-oac";
  const existing = await cf.send(new ListOriginAccessControlsCommand({ MaxItems: 100 }));
  const found = existing.OriginAccessControlList?.Items?.find((o) => o.Name === OAC_NAME);
  if (found?.Id) {
    oacId = found.Id;
    skip(`OAC "${OAC_NAME}" already exists (${oacId})`);
  } else {
    const oacRes = await cf.send(new CreateOriginAccessControlCommand({
      OriginAccessControlConfig: {
        Name: OAC_NAME,
        Description: "OAC for jeffspace-shell S3 bucket",
        OriginAccessControlOriginType: "s3",
        SigningBehavior: "always",
        SigningProtocol: "sigv4",
      },
    }));
    oacId = oacRes.OriginAccessControl?.Id!;
    ok(`CloudFront OAC created (${oacId})`);
  }

  // Create distribution
  const distRef = `jeffspace-shell-${Date.now()}`;
  const distRes = await cf.send(new CreateDistributionCommand({
    DistributionConfig: {
      CallerReference: distRef,
      Comment: "Jeffspace shell app",
      Enabled: true,
      DefaultRootObject: "index.html",
      HttpVersion: "http2",
      PriceClass: "PriceClass_100",
      Origins: {
        Quantity: 1,
        Items: [{
          Id: "jeffspace-shell-s3",
          DomainName: `${BUCKETS.shell}.s3.${REGION}.amazonaws.com`,
          S3OriginConfig: { OriginAccessIdentity: "" }, // required but empty when using OAC
          OriginAccessControlId: oacId,
        }],
      },
      DefaultCacheBehavior: {
        TargetOriginId: "jeffspace-shell-s3",
        ViewerProtocolPolicy: "redirect-to-https",
        AllowedMethods: {
          Quantity: 2,
          Items: ["GET", "HEAD"],
          CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
        },
        Compress: true,
        CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6", // AWS Managed: CachingOptimized
      },
      CustomErrorResponses: {
        Quantity: 2,
        Items: [
          { ErrorCode: 403, ResponseCode: "200", ResponsePagePath: "/index.html", ErrorCachingMinTTL: 0 },
          { ErrorCode: 404, ResponseCode: "200", ResponsePagePath: "/index.html", ErrorCachingMinTTL: 0 },
        ],
      },
    },
  }));

  const dist = distRes.Distribution!;
  const distributionId  = dist.Id;
  const distributionArn = dist.ARN;
  const domain          = dist.DomainName;

  ok(`CloudFront distribution created: ${distributionId}`);
  info(`Domain: https://${domain}  (takes ~15 min to propagate)`);

  // Attach bucket policy allowing CloudFront OAC to read the shell bucket
  const shellPolicy = {
    Version: "2012-10-17",
    Statement: [{
      Sid: "AllowCloudFrontOAC",
      Effect: "Allow",
      Principal: { Service: "cloudfront.amazonaws.com" },
      Action: "s3:GetObject",
      Resource: `arn:aws:s3:::${BUCKETS.shell}/*`,
      Condition: {
        StringEquals: {
          "AWS:SourceArn": distributionArn,
        },
      },
    }],
  };
  await s3.send(new PutBucketPolicyCommand({
    Bucket: BUCKETS.shell,
    Policy: JSON.stringify(shellPolicy, null, 2),
  }));
  ok(`bucket policy on "${BUCKETS.shell}" grants CloudFront read access`);

  return domain;
}

// ---------------------------------------------------------------------------
// Update config.ts
// ---------------------------------------------------------------------------

function updateShellConfig(cloudfrontDomain: string): void {
  const configPath = join(ROOT, "apps", "shell", "src", "config.ts");
  let src = readFileSync(configPath, "utf-8");

  src = src.replace(
    /defaultAppBucket:\s*"[^"]*"/,
    `defaultAppBucket: "${BUCKETS.modules}"`
  );
  // Keep defaultAppConfigPath as-is — it's a logical path, not bucket-specific

  writeFileSync(configPath, src, "utf-8");
  ok(`apps/shell/src/config.ts updated (defaultAppBucket → "${BUCKETS.modules}")`);
}

function updatePublishScript(): void {
  const publishPath = join(ROOT, "scripts", "publish-module.ts");
  let src = readFileSync(publishPath, "utf-8");

  src = src.replace(
    /registryBucket:\s*process\.env\["HEP_REGISTRY_BUCKET"\]\s*\?\?\s*""/,
    `registryBucket: process.env["HEP_REGISTRY_BUCKET"] ?? "${BUCKETS.registry}"`
  );

  writeFileSync(publishPath, src, "utf-8");
  ok(`scripts/publish-module.ts updated (default registry bucket → "${BUCKETS.registry}")`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\nProvisioning Jeffspace AWS resources...\n");

  const accountId = await getAccountId();
  info(`AWS account: ${accountId} / region: ${REGION}`);

  // ── S3 ──────────────────────────────────────────────────────────────────
  console.log("\n[S3 buckets]");
  for (const bucket of Object.values(BUCKETS)) {
    await ensureBucket(bucket);
    await blockPublicAccess(bucket);
  }
  await configureDataBucketCors(BUCKETS.modules);
  await configureDataBucketCors(BUCKETS.registry);

  // ── DynamoDB ─────────────────────────────────────────────────────────────
  console.log("\n[DynamoDB tables]");
  await ensureProjectsTable();
  await ensureSimpleTable(TABLES.registry, "moduleName", "version");
  await ensureSimpleTable(TABLES.locks,    "projectId");

  // ── IAM ──────────────────────────────────────────────────────────────────
  console.log("\n[IAM — Cognito authenticated role]");
  await updateCognitoRolePolicy(accountId);

  // ── CloudFront ────────────────────────────────────────────────────────────
  console.log("\n[CloudFront]");
  const cloudfrontDomain = await createShellDistribution(accountId);

  // ── Config updates ────────────────────────────────────────────────────────
  console.log("\n[Updating source config]");
  updateShellConfig(cloudfrontDomain);
  updatePublishScript();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Jeffspace AWS provisioning complete                         ║
╚══════════════════════════════════════════════════════════════╝

  Shell URL:   https://${cloudfrontDomain}
               (CloudFront takes ~15 min to go live)

  Modules bucket:   ${BUCKETS.modules}
  Registry bucket:  ${BUCKETS.registry}
  Shell bucket:     ${BUCKETS.shell}

  Tables: ${Object.values(TABLES).join(", ")}

Next steps:
  1. Publish all modules to the registry:
       npm run publish:local  →  (already in registry; re-publish for real AWS:)
       npx tsx scripts/publish-module.ts --module=<name>

  2. Deploy the shell app:
       npx tsx scripts/deploy-shell.ts

  3. Add the CloudFront URL to your Google OAuth client's
     authorized JavaScript origins:
       https://console.cloud.google.com/apis/credentials
       Allowed origin: https://${cloudfrontDomain}

  HEP_REGISTRY_BUCKET=${BUCKETS.registry}
  AWS_REGION=${REGION}
`);
}

main().catch((err) => {
  console.error("\nProvisioning failed:", err);
  process.exit(1);
});
