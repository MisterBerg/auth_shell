declare module "@aws-sdk/s3-request-presigner" {
  export function getSignedUrl(client: unknown, command: unknown, options?: { expiresIn?: number }): Promise<string>;
}
