// Shared by provider evidence and the portal; no credentials or network access are needed.
export function repositorySourceUrl(kind: string, instance: string, repository: string, revision: string, file: string, externalId?: string) {
  const base = new URL(instance);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Invalid source instance");
  const encodePath = (value: string) => {
    const parts = value.split("/");
    if (!value || /[\0\r\n\\]/.test(value) || parts.some(p => !p || p === "." || p === "..")) throw new Error("Invalid source path");
    return parts.map(encodeURIComponent).join("/");
  };
  if (!revision || /[\0\r\n]/.test(revision)) throw new Error("Source revision missing or invalid");
  const origin = base.origin + base.pathname.replace(/\/$/, ""), repo = encodePath(repository), path = encodePath(file), ref = encodeURIComponent(revision);
  switch (kind) {
    case "github":
    case "github-enterprise": return `${origin}/${repo}/blob/${ref}/${path}`;
    case "gitlab": return `${origin}/${repo}/-/blob/${ref}/${path}`;
    case "gitea": return `${origin}/${repo}/src/commit/${ref}/${path}`;
    case "bitbucket-cloud":
      if (repository.split("/").length !== 2) throw new Error("Invalid Bitbucket repository name");
      return `https://bitbucket.org/${repo}/src/${ref}/${path}`;
    case "bitbucket-dc": {
      const parts = repository.split("/");
      if (parts.length !== 2) throw new Error("Invalid Bitbucket repository");
      return `${origin}/projects/${encodeURIComponent(parts[0])}/repos/${encodeURIComponent(parts[1])}/browse/${path}?at=${ref}`;
    }
    case "origin": {
      if (repository.split("/").length !== 2 || externalId && !/^[A-Za-z0-9_-]{1,200}$/.test(externalId)) throw new Error("Invalid Origin source identity");
      // Retrieval binds the immutable repository ID; browser evidence uses the native portal.
      return `https://cursor.com/codebase/${repo}/blob/${ref}/${path}`;
    }
    default: throw new Error("Provider source links unavailable");
  }
}
