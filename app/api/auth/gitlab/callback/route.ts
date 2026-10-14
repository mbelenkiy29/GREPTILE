import { finishOAuth } from "../../../../../src/oauth-flow";
import { gitlabProfile } from "../../../../../src/identity";

export async function GET(request: Request) {
  return finishOAuth(request, "gitlab", (code, redirectUri) => gitlabProfile(code, redirectUri));
}
