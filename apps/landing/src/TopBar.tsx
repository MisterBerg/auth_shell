
import type { UserProfile } from "module-core";

type TopBarProps = {
  userProfile?: UserProfile;
  onNewProject: () => void;
};

export function TopBar({ userProfile, onNewProject }: TopBarProps) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 1.5rem",
        height: "56px",
        background: "#0f1929",
        borderBottom: "1px solid #1e2d40",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontSize: "1.1rem",
          fontWeight: 600,
          letterSpacing: "-0.01em",
          color: "#e5e7eb",
        }}
      >
        Jeffspace
      </span>

      <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
        <button
          onClick={onNewProject}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.35rem",
            padding: "0.4rem 0.85rem",
            borderRadius: "6px",
            border: "1px solid #3b82f6",
            background: "transparent",
            color: "#3b82f6",
            cursor: "pointer",
            fontSize: "0.875rem",
            fontWeight: 500,
          }}
        >
          <span style={{ fontSize: "1rem", lineHeight: 1 }}>+</span>
          New Project
        </button>

        <UserBadge userProfile={userProfile} />
      </div>
    </div>
  );
}

function UserBadge({ userProfile }: { userProfile?: UserProfile }) {
  const name = userProfile?.name ?? userProfile?.email ?? "Signed in";

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        cursor: "default",
      }}
      title={userProfile?.email}
    >
      {userProfile?.picture ? (
        <img
          src={userProfile.picture}
          alt={name}
          style={{ width: 32, height: 32, borderRadius: "50%", flexShrink: 0 }}
        />
      ) : (
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            background: "#1e3a5f",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.8rem",
            fontWeight: 600,
            color: "#93c5fd",
            flexShrink: 0,
          }}
        >
          {name.charAt(0).toUpperCase()}
        </div>
      )}
      <span style={{ fontSize: "0.875rem", color: "#9ca3af", maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </span>
    </div>
  );
}
