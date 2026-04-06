export type ProjectRecord = {
  userId: string;
  projectId: string;
  role: "owner" | "editor" | "viewer";
  rootConfigPath: string;
  rootBucket: string;
  displayName: string;
  description?: string;
  thumbnailKey?: string;
  createdAt: string;
  updatedAt: string;
  // Present on records returned via the sharedWithUserId GSI
  sharedWithUserId?: string;
  ownerEmail?: string;
};
