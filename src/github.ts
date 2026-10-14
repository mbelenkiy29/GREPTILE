import {changeMetadataSchema,catalogPageSize,numberedPage,validateChangePage,type ChangeMetadata,type ChangePage} from "./change-metadata";
import {githubWebOrigin} from "./github-enterprise";
import { reviewLinks } from "./review-summary";
import { createHmac, timingSafeEqual } from "node:crypto";
import { repositorySourceUrl } from "./source-url";
import { importPKCS8, SignJWT } from "jose";
import { z } from "zod";
import type { ChangedFile, Finding, SourceFile } from "./engine/types";
import {changedLines} from "./engine/diff";
import {findingComment} from "./review-summary";

export function verifyWebhook(
  body: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!secret || !signature || !/^sha256=[a-f0-9]{64}$/.test(signature))
    return false;
  const expected = Buffer.from(
    createHmac("sha256", secret).update(body).digest("hex"),
    "hex",
  );
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}
const repoSchema = z.object({
  id: z.number().int(),
  full_name: z.string(),
  name: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
  owner: z.object({ login: z.string(),id:z.number().int().positive().optional(),type:z.string().optional() }),
});
export type GithubRepository = z.infer<typeof repoSchema>;
export function findingFingerprint(body:string){
  if(/<!-- openreview:conversation:[^>]+ -->\s*$/.test(body))return undefined;
  return [...body.matchAll(/<!-- openreview-finding:([a-f0-9]+) -->/g)].at(-1)?.[1];
}
export class GithubApiError extends Error {
 constructor(message:string,readonly status:number,readonly planRestricted=false){super(message);}
}
export class Github {
  readonly supportsApproval:boolean = true;
  constructor(private token: string, private base = "https://api.github.com", private appSlug?:()=>Promise<string>) {}
  protected async publisherLogin(){return this.appSlug?(await this.appSlug())+"[bot]":(await this.request("/user",z.object({login:z.string().min(1)}))).login;}
  sourceUrl(repository:string,revision:string,file:string) {
    const origin=githubWebOrigin(this.base);
    return repositorySourceUrl("github",origin,repository,revision,file);
  }
  static async installation(id: number, configuration?: {appId:string;privateKey:string;base:string}): Promise<Github> {
    const appId = configuration?.appId ?? process.env.GITHUB_APP_ID,
      pem = (configuration?.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY)?.replace(/\\n/g, "\n");
    if (!appId || !pem)
      throw new Error("Configure GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY");
    const key = await importPKCS8(pem, "RS256");
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(appId)
      .setIssuedAt(now - 30)
      .setExpirationTime(now + 540)
      .sign(key);
    const app = new Github(jwt, configuration?.base);
    const token = await app.request(
      `/app/installations/${id}/access_tokens`,
      z.object({ token: z.string(), permissions: z.record(z.string()) }),
      { method: "POST", body: "{}" },
    );
    if (
      (token.permissions.contents !== "read" &&
        token.permissions.contents !== "write") ||
      token.permissions.pull_requests !== "write"
    )
      throw new Error(
        "GitHub App requires contents:read and pull_requests:write",
      );
    if (
      !["read", "write"].includes(token.permissions.issues ?? "") ||
      !["read", "write"].includes(token.permissions.checks ?? "")
    )
      throw new Error(
        "GitHub App requires issues:read and checks:read for follow-ups and CI context",
      );
    return new Github(token.token, configuration?.base, async()=> (await app.request(`/app/installations/${id}`,z.object({app_slug:z.string().min(1)}))).app_slug);
  }
  async request<T>(
    endpoint: string,
    schema: z.ZodType<T>,
    options: RequestInit = {},
  ): Promise<T> {
    if (
      !endpoint.startsWith("/") ||
      endpoint.startsWith("//") ||
      endpoint.includes("://")
    )
      throw new Error("Invalid GitHub API path");
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await fetch(this.base + endpoint, {
        ...options,
        redirect: "error",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${this.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "OpenReview",
          "content-type": "application/json",
          ...options.headers,
        },
        signal: AbortSignal.timeout(60000),
      });
      console.log(
        JSON.stringify({
          event: "github.request",
          path: endpoint.split("?")[0],
          method: options.method ?? "GET",
          status: response.status,
          attempt: attempt + 1,
        }),
      );
      if (!response.ok) {
        if (
          (response.status === 429 || response.status >= 500) &&
          attempt < 2 &&
          (!options.method || options.method === "GET")
        ) {
          await new Promise((r) =>
            setTimeout(
              r,
              Math.min(
                15000,
                Number(response.headers.get("retry-after") ?? 2 ** attempt) *
                  1000,
              ),
            ),
          );
          continue;
        }
        const errorBody=await response.json().catch(()=>null) as {message?:unknown}|null;
        throw new GithubApiError(
          `GitHub ${options.method ?? "GET"} ${endpoint.split("?")[0]}: HTTP ${response.status}`,
          response.status,response.status===403&&errorBody?.message==="Upgrade to GitHub Pro or make this repository public to enable this feature.",
        );
      }
      if (response.status === 204) return schema.parse(null);
      return schema.parse(await response.json());
    }
    throw new Error("GitHub retries exhausted");
  }
  async paginate<T>(endpoint: string, schema: z.ZodType<T>): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= 100; page++) {
      const items = await this.request(
        `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        z.array(schema),
      );
      result.push(...items);
      if (items.length < 100) return result;
    }
    throw new Error("GitHub pagination exceeds safe limit");
  }
  async repositories(): Promise<GithubRepository[]> {
    const result: GithubRepository[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(
        `/installation/repositories?per_page=100&page=${page}`,
        z.object({ repositories: z.array(repoSchema) }),
      );
      result.push(...response.repositories);
      if (response.repositories.length < 100) return result;
    }
    throw new Error(
      "Installation repository count exceeds supported pagination",
    );
  }
  async installationInfo(id: number) {
    return this.request(
      `/app/installations/${id}`,
      z.object({
        id: z.number(),
        account: z.object({
          id: z.number(),
          login: z.string(),
          type: z.string(),
        }),
        permissions: z.record(z.string()),
      }),
    );
  }
  async head(repository:string,branch:string) {return (await this.request("/repos/"+repository+"/commits/"+encodeURIComponent(branch),z.object({sha:z.string()}))).sha;}
  async canReply(repository:string,author:string){const permission=await this.request(`/repos/${repository}/collaborators/${encodeURIComponent(author)}/permission`,z.object({permission:z.string()}));return ["admin","maintain","write"].includes(permission.permission);}
  async approvalSnapshot(repository:string,number:number,extraChecks:{name:string;appId?:number}[]=[]){
    const pr=await this.pullRequest(repository,number),prefix=`/repos/${repository}`;
    const [branch,rules,reviews,installation]=await Promise.all([
      this.request(prefix+"/branches/"+encodeURIComponent(pr.base.ref),z.object({protected:z.boolean()})),
      this.paginate(prefix+"/rules/branches/"+encodeURIComponent(pr.base.ref),z.object({type:z.string(),parameters:z.unknown().optional()})).catch(error=>{if(error instanceof GithubApiError&&error.planRestricted)return error;throw error;}),
      this.paginate(prefix+"/pulls/"+number+"/reviews",z.object({id:z.number(),body:z.string().nullable(),commit_id:z.string(),state:z.string(),user:z.object({login:z.string(),type:z.string()})})),
      this.appSlug ? this.appSlug().then(app_slug=>({app_slug})) : Promise.reject(new Error("Installing App identity unavailable for approval")),
    ]);
    const required:{name:string;appId?:number}[]=[];
    if(rules instanceof GithubApiError&&branch.protected)throw rules;
    if(branch.protected){
      // A permission error or ambiguous 404 must not mean "no required checks".
      const protection=await this.request(prefix+"/branches/"+encodeURIComponent(pr.base.ref)+"/protection",z.object({required_status_checks:z.object({contexts:z.array(z.string()),checks:z.array(z.object({context:z.string(),app_id:z.number().nullable()})).optional()}).nullable()}));
      for(const c of protection.required_status_checks?.checks??[])required.push({name:c.context,...(c.app_id&&c.app_id>0?{appId:c.app_id}:{})});
      for(const name of protection.required_status_checks?.contexts??[])if(!required.some(c=>c.name===name))required.push({name});
    }
    // Native feature unavailable on Free private repositories + unprotected branch proves no active branch rules.
    // Other permission errors remain fatal; never infer absence from a generic 403 or 404.
    for(const rule of rules instanceof GithubApiError?[]:rules)if(rule.type==="required_status_checks"){
      const parameters=z.object({required_status_checks:z.array(z.object({context:z.string(),integration_id:z.number().nullable().optional()}))}).parse(rule.parameters);
      for(const c of parameters.required_status_checks)required.push({name:c.context,...(c.integration_id&&c.integration_id>0?{appId:c.integration_id}:{})});
    }
    const checks:{name:string;appId?:number;status:string;conclusion:string|null}[]=[];
    for(let page=1;;page++){
      if(page>100)throw new Error("Approval check pagination exceeds safe limit");
      const result=await this.request(prefix+"/commits/"+pr.head.sha+"/check-runs?filter=latest&per_page=100&page="+page,z.object({check_runs:z.array(z.object({id:z.number(),name:z.string(),status:z.string(),conclusion:z.string().nullable(),app:z.object({id:z.number()})}))}));
      checks.push(...result.check_runs.map(c=>({name:c.name,appId:c.app.id,status:c.status,conclusion:c.conclusion})));
      if(result.check_runs.length<100)break;
    }
    const statuses=[...required,...extraChecks].some(c=>c.appId===undefined)?await this.paginate(prefix+"/commits/"+pr.head.sha+"/statuses",z.object({context:z.string(),state:z.string()})):[],seen=new Set<string>();
    for(const s of statuses){if(seen.has(s.context))continue;seen.add(s.context);checks.push({name:s.context,status:s.state==="pending"?"in_progress":"completed",conclusion:s.state});}
    const latestHuman=new Map<string,string>();
    for(const r of reviews)if(r.user.type!=="Bot"&&["APPROVED","CHANGES_REQUESTED","DISMISSED"].includes(r.state))latestHuman.set(r.user.login,r.state);
    return {pr,checks,nativeRequiredChecks:required,humanChangeRequested:[...latestHuman.values()].includes("CHANGES_REQUESTED"),reviews,botLogin:installation.app_slug+"[bot]"};
  }
  async approve(repository:string,number:number,head:string,marker:string,botLogin:string){
    if(!/^[a-f0-9]{40}$/.test(head)||!marker.startsWith("<!-- openreview:approval:")||!botLogin.endsWith("[bot]"))throw new Error("Invalid approval identity or revision");
    const previous=await this.paginate(`/repos/${repository}/pulls/${number}/reviews`,z.object({id:z.number(),body:z.string().nullable(),commit_id:z.string(),state:z.string(),user:z.object({login:z.string()})}));
    const old=previous.find(r=>r.commit_id===head&&r.body?.includes(marker)&&r.user.login===botLogin&&r.state==="APPROVED");
    if(old)return {id:old.id,reused:true};
    const current=await this.request(`/repos/${repository}/pulls/${number}`,z.object({state:z.string(),draft:z.boolean(),head:z.object({sha:z.string()})}));
    if(current.head.sha!==head||current.state!=="open"||current.draft)throw new Error("Approval revision changed");
    const review=await this.request(`/repos/${repository}/pulls/${number}/reviews`,z.object({id:z.number(),commit_id:z.string(),state:z.literal("APPROVED")}),{method:"POST",body:JSON.stringify({event:"APPROVE",commit_id:head,body:"OpenReview approved this exact revision after all configured approval gates passed. No merge was performed.\n\n"+marker})});
    if(review.commit_id!==head)throw new Error("Provider returned an approval for another revision");
    return {id:review.id,reused:false};
  }
  async dismissApproval(repository:string,number:number,id:number){
    const review=await this.request(`/repos/${repository}/pulls/${number}/reviews/${id}`,z.object({state:z.string()}));
    if(review.state==="DISMISSED")return;
    await this.request(`/repos/${repository}/pulls/${number}/reviews/${id}/dismissals`,z.unknown(),{method:"PUT",body:JSON.stringify({message:"OpenReview approval invalidated: revision or trusted approval policy changed."})});
  }
  async archive(repository:string,sha:string):Promise<Uint8Array>{
    if(!/^[a-f0-9]{40}$/.test(sha))throw new Error("Runtime archive requires an exact Git commit");
    const response=await fetch(this.base+`/repos/${repository}/tarball/${sha}`,{headers:{authorization:`Bearer ${this.token}`,accept:"application/vnd.github+json"},redirect:"manual",signal:AbortSignal.timeout(60000)});
    let archive=response;
    if([301,302,307,308].includes(response.status)){
      const location=new URL(response.headers.get("location")??"",this.base),base=new URL(this.base);
      if(location.protocol!=="https:"||location.username||location.password||![base.hostname,"codeload.github.com"].includes(location.hostname))throw new Error("Runtime archive redirects to an unauthorized host");
      archive=await fetch(location,{redirect:"error",headers:location.origin===base.origin?{authorization:`Bearer ${this.token}`}:{},signal:AbortSignal.timeout(60000)});
    }
    if(!archive.ok||Number(archive.headers.get("content-length")??0)>20000000)throw new Error("Runtime archive unavailable or too large");
    const reader=archive.body?.getReader();if(!reader)throw new Error("Runtime archive missing");
    const parts:Uint8Array[]=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>20000000)throw new Error("Runtime archive exceeds 20 MB");parts.push(value);}}finally{await reader.cancel();}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
  }
  async changeMetadata(repository:string,number:number):Promise<ChangeMetadata>{
    const pr=await this.request(`/repos/${repository}/pulls/${number}`,changeMetadataSchema);
    if(pr.number!==number)throw new Error("GitHub change identity mismatch");return pr;
  }
  async openChanges(repository:string,cursor:string|null):Promise<ChangePage>{
    const page=numberedPage(cursor),rows=await this.request(`/repos/${repository}/pulls?state=open&sort=created&direction=asc&per_page=${catalogPageSize}&page=${page}`,z.array(z.object({number:z.number().int().positive().safe()})).max(catalogPageSize));
    return validateChangePage({numbers:rows.map(r=>r.number),next:rows.length===catalogPageSize?String(page+1):null},cursor);
  }
  async pullRequest(repository: string, number: number) {
    const prefix = `/repos/${repository}`;
    const pr = await this.request(
      `${prefix}/pulls/${number}`,
      z.object({
        number: z.number(),
        title: z.string(),
        body: z.string().nullable(),
        draft: z.boolean(),
        state: z.string(),
        html_url: z.string(),
        user: z.object({ id:z.number().int().positive().optional(),login: z.string() }),
        head: z.object({ sha: z.string(), ref: z.string() }),
        base: z.object({ sha: z.string(), ref: z.string() }),
      }),
    );
    const files = await this.paginate(
      `${prefix}/pulls/${number}/files`,
      z.object({
        filename: z.string(),
        previous_filename: z.string().optional(),
        status: z.string(),
        patch: z.string().optional(),
        changes: z.number(),
      }),
    );
    if (
      files.some(
        (f) =>
          !f.patch &&
          f.changes > 0 &&
          !/\.(png|jpg|gif|pdf|zip|ico|woff2?)$/.test(f.filename),
      )
    )
      throw new Error(
        "GitHub omitted/truncated a text diff; split this PR to ensure complete review",
      );
    const diff: ChangedFile[] = files.map((f) => ({
      path: f.filename,
      previousPath: f.previous_filename,
      patch: f.patch ?? "",
      status: f.status,
    }));
    const [comments, reviews, commits, checks] = await Promise.all([
      this.paginate(
        `${prefix}/pulls/${number}/comments`,
        z.object({
          id: z.number(),
          body: z.string(),
          path: z.string(),
          line: z.number().nullable(),
          user: z.object({ login: z.string() }),
        }),
      ),
      this.paginate(
        `${prefix}/pulls/${number}/reviews`,
        z.object({
          id: z.number(),
          body: z.string().nullable(),
          commit_id: z.string(),
          state: z.string(),
        }),
      ),
      this.paginate(
        `${prefix}/pulls/${number}/commits`,
        z.object({ sha: z.string() }),
      ),
      this.request(
        `${prefix}/commits/${pr.head.sha}/check-runs?per_page=100`,
        z.object({
          check_runs: z.array(
            z.object({
              name: z.string(),
              status: z.string(),
              conclusion: z.string().nullable(),
            }),
          ),
        }),
      ),
    ]);
    return {
      ...pr,
      ...(pr.user.id?{authorExternalId:String(pr.user.id)}:{}),
      diff,
      comments,
      reviews,
      commits,
      checks: checks.check_runs,
    };
  }
  async branches(repository: string) {
    const schema = z.array(
      z.object({
        name: z.string(),
        commit: z.object({ sha: z.string() }),
        protected: z.boolean(),
      }),
    );
    const branches: z.infer<typeof schema> = [];
    // ponytail: bounded metadata snapshot; use a paginated branch table when more than 200 need browsing.
    for (let page = 1; page <= 3; page++) {
      const values = await this.request(
        `/repos/${repository}/branches?per_page=100&page=${page}`,
        schema,
      );
      if (page === 3)
        return {
          branches: branches.map((branch) => ({
            name: branch.name,
            sha: branch.commit.sha,
            protected: branch.protected,
          })),
          limited: values.length > 0,
        };
      branches.push(...values);
      if (values.length < 100) break;
    }
    return {
      branches: branches.map((branch) => ({
        name: branch.name,
        sha: branch.commit.sha,
        protected: branch.protected,
      })),
      limited: false,
    };
  }
  async tree(repository: string, sha: string) {
    const result = await this.request(
      `/repos/${repository}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
      z.object({
        truncated: z.boolean(),
        tree: z.array(
          z.object({
            path: z.string(),
            type: z.string(),
            sha: z.string(),
            size: z.number().optional(),
          }),
        ),
      }),
    );
    if (result.truncated)
      throw new Error(
        "Repository tree exceeds GitHub recursive tree limit; subtree indexing required",
      );
    return result.tree.filter(f => f.type === "blob");
  }

  async blob(
    repository: string,
    path: string,
    sha: string,
  ): Promise<SourceFile> {
    const blob = await this.request(
      `/repos/${repository}/git/blobs/${sha}`,
      z.object({
        content: z.string(),
        encoding: z.literal("base64"),
        size: z.number(),
      }),
    );
    if (blob.size > 200000) return {path,sha,size:blob.size,content:""};
    return {
      path,
      sha,
      content: Buffer.from(blob.content.replace(/\n/g, ""), "base64").toString(
        "utf8",
      ),
    };
  }
  async publish(
    repository: string,
    number: number,
    sha: string,
    summary: string,
    findings: Finding[],
    marker: string,
    style: string = "detailed",
    _revisionKey?: string,
    unresolvedCount = findings.length,
  ): Promise<{
    id: number;
    reused: boolean;
    comments?: { id: number; fingerprint: string }[];
  }> {
    const prefix=`/repos/${repository}/pulls/${number}`;
    const current=async()=>{const pr=await this.request(prefix,z.object({head:z.object({sha:z.string()}),state:z.string()}));if(pr.head.sha!==sha||pr.state!=="open")throw new Error("Review is obsolete; pull request head changed or closed");};
    await current();
    const publisher=await this.publisherLogin();
    const existing = await this.paginate(
      `/repos/${repository}/pulls/${number}/reviews`,
      z.object({ id: z.number(), body: z.string().nullable(),commit_id:z.string(),state:z.string(),user:z.object({login:z.string()}) }),
    );
    const prior = existing.find((r) =>
      r.body?.trimEnd().endsWith(`<!-- openreview:${marker} -->`) && r.commit_id===sha && r.state==="COMMENTED" && r.user.login===publisher,
    );
    if (prior){const comments=await this.findingComments(repository, number, prior.id,findings,sha);await current();
      return {
        id: prior.id,
        reused: true,
        comments,
      };
    }
    if(findings.length){const files=await this.paginate(prefix+"/files",z.object({filename:z.string(),patch:z.string().optional()}));for(const f of findings)if(f.commitSha!==sha||!changedLines(files.find(d=>d.filename===f.filePath)?.patch??"").has(f.startLine))throw new Error("Finding line not in complete current diff");}
    await current();
    const comments = findings.map((f) => ({
      path: f.filePath,
      line: f.startLine,
      side: "RIGHT",
      body: findingComment(f, style) + (process.env.APP_URL ? `\n\n[Fix with your agent](${process.env.APP_URL}/fix/${marker}?finding=${f.fingerprint})` : ""),
    }));
    const result = await this.request(
      `/repos/${repository}/pulls/${number}/reviews`,
      z.object({ id: z.number(),commit_id:z.string(),user:z.object({login:z.string()}) }),
      {
        method: "POST",
        body: JSON.stringify({
          commit_id: sha,
          event: "COMMENT",
          body: `## OpenReview\n\n${summary}${reviewLinks(marker,unresolvedCount)}\n\n<!-- openreview:${marker} -->`,
          comments,
        }),
      },
    );
    if(result.commit_id!==sha||result.user.login!==publisher)throw new Error("GitHub returned another publication identity or revision");
    const mapped=await this.findingComments(repository, number, result.id,findings,sha);await current();
    return {
      id: result.id,
      reused: false,
      comments: mapped,
    };
  }
  async findingComments(repository: string, number: number, reviewId: number,findings?:Finding[],sha?:string) {
    const publisher=await this.publisherLogin();
    const comments = await this.paginate(
      `/repos/${repository}/pulls/${number}/reviews/${reviewId}/comments`,
      z.object({ id: z.number(), body: z.string(),user:z.object({login:z.string()}),path:z.string(),line:z.number().nullable().optional(),position:z.number().nullable().optional(),commit_id:z.string(),pull_request_review_id:z.number(),in_reply_to_id:z.number().optional() }),
    );
    const mapped=comments.flatMap((c) => {
      if(c.user.login!==publisher||c.pull_request_review_id!==reviewId||c.in_reply_to_id!==undefined||(sha!==undefined&&c.commit_id!==sha))return [];
      const fingerprint=findingFingerprint(c.body);
      return fingerprint&&(!findings||findings.some(f=>f.fingerprint===fingerprint&&f.filePath===c.path&&f.startLine===(c.line===undefined?c.position:c.line))) ? [{ id: c.id, fingerprint }] : [];
    });
    if(findings&&findings.some(f=>!mapped.some(c=>c.fingerprint===f.fingerprint)))throw new Error("Finding publication incomplete; retry or re-review the current revision");return mapped;
  }
  async reply(
    repository: string,
    number: number,
    body: string,
    reviewCommentId?: string | number,
    marker?: string,
  ) {
    if(reviewCommentId!==undefined&&(typeof reviewCommentId!=="number"||!Number.isSafeInteger(reviewCommentId)||reviewCommentId<1))throw new Error("Invalid GitHub review comment identity");
    const publisher=await this.publisherLogin();
    if (marker) {
      const comments = await this.paginate(
        reviewCommentId
          ? `/repos/${repository}/pulls/${number}/comments`
          : `/repos/${repository}/issues/${number}/comments`,
        z.object({ id: z.number(), body: z.string(),user:z.object({login:z.string()}),in_reply_to_id:z.number().optional() }),
      );
      const previous = comments.find((c) =>
        c.user.login===publisher&&c.body.trimEnd().endsWith(`<!-- openreview:${marker} -->`)&&(!reviewCommentId||c.in_reply_to_id===Number(reviewCommentId)),
      );
      if (previous) return { id: previous.id };
      body += `\n\n<!-- openreview:${marker} -->`;
    }
    const endpoint = reviewCommentId
      ? `/repos/${repository}/pulls/${number}/comments/${reviewCommentId}/replies`
      : `/repos/${repository}/issues/${number}/comments`;
    const result=await this.request(endpoint, z.object({ id: z.number(),user:z.object({login:z.string()}) }), {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    if(result.user.login!==publisher)throw new Error("GitHub returned another reply author");return {id:result.id};
  }
}

export {findingComment} from "./review-summary";
