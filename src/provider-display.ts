export type ProviderDisplayIdentity={kind:string;name:string;instance:string;externalId:string|null};
const names:Record<string,string>={github:"GitHub", "github-enterprise":"GitHub Enterprise",gitlab:"GitLab",gitea:"Gitea", "bitbucket-cloud":"Bitbucket Cloud","bitbucket-dc":"Bitbucket Data Center",origin:"Cursor Origin",perforce:"Perforce"};
export function providerDisplay(identity:ProviderDisplayIdentity|null){
 if(!identity)return "Provider identity unavailable";
 let instance="Instance unavailable";
 try{const url=new URL(identity.instance);instance=url.host+url.pathname.replace(/\/$/,"");}catch{ /* Do not display malformed connection input. */ }
 return `${names[identity.kind]??identity.kind} · ${identity.name} · ${instance}${identity.externalId?` · Repository ID ${identity.externalId}`:""}`;
}
export function repositoryDisplay(repository:{fullName:string;provider?:ProviderDisplayIdentity|null}|null|undefined){
 if(!repository)return "Repository unavailable";
 return `${repository.fullName} · ${providerDisplay(repository.provider??null)}`;
}
