import type {QueryCtx} from "./_generated/server";
import type {Doc} from "./_generated/dataModel";
export async function repositoryIdentity(ctx:QueryCtx,repo:Doc<"repositories">){
 if(!repo.connectionId)return {kind:"github",name:"GitHub App",instance:"https://github.com",externalId:repo.githubId===undefined?null:String(repo.githubId)};
 const connection=await ctx.db.get(repo.connectionId);
 return connection?.organizationId===repo.organizationId?{kind:connection.kind,name:connection.name,instance:connection.instance,externalId:repo.externalId??null}:null;
}
