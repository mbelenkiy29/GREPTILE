import { finishOAuth } from "../../../../../src/oauth-flow";
import { googleProfile } from "../../../../../src/identity";

export async function GET(request: Request) {
  return finishOAuth(request, "google", (code, redirectUri) => googleProfile(code, redirectUri));
}
