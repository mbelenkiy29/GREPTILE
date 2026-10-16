import {authenticatedBitbucketIdentity} from './bitbucket-identity';
import {z} from 'zod';
import {githubEnterpriseEndpoints} from './github-enterprise';
import {personalIdentityProviders} from './personal-providers';
import {providerOrigin} from './credentials';
import {scmFetch,type ScmNetwork} from './scm-transport';
// GitLab requests use the connection's network settings (internal API URL, CA bundle, proxy).
export async function authenticatedProviderIdentity(kind:string,instance:string,token:string,network:ScmNetwork={}){
 if(kind==='origin'||kind==='bitbucket-cloud'||!personalIdentityProviders.includes(kind))throw new Error('Personal identity verification is unavailable for this provider');
 if(!token||token.length>4096||/[\r\n]/.test(token))throw new Error('Invalid personal access token');
 if(kind==='bitbucket-dc')return authenticatedBitbucketIdentity(instance,token);
 const base=kind==='github-enterprise'?githubEnterpriseEndpoints(instance).api:kind==='gitlab'&&network.apiUrl?network.apiUrl:providerOrigin(instance,kind==='gitlab'?['gitlab.com']:[]),response=await (kind==='gitlab'?scmFetch(network):fetch)(base+(kind==='github-enterprise'?'/user':kind==='gitlab'?'/api/v4/user':'/api/v1/user'),{redirect:'error',headers:kind==='gitlab'?{'PRIVATE-TOKEN':token}:kind==='github-enterprise'?{authorization:'Bearer '+token,accept:'application/vnd.github+json'}:{authorization:'token '+token},signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw new Error('Personal provider identity could not be authenticated');
 const raw=await response.json();
 if(kind==='gitlab'){const u=z.object({id:z.number().int().positive(),username:z.string().min(1),state:z.literal('active'),bot:z.boolean().optional()}).parse(raw);if(u.bot)throw new Error('Link a personal account rather than a provider bot');return {externalId:String(u.id),username:u.username};}
 if(kind==='github-enterprise'){const u=z.object({id:z.number().int().positive(),login:z.string().min(1),type:z.literal('User'),suspended_at:z.null().optional()}).parse(raw);return {externalId:String(u.id),username:u.login};}
 const u=z.object({id:z.number().int().positive(),login:z.string().min(1),active:z.literal(true),prohibit_login:z.literal(false),type:z.literal('User')}).parse(raw);return {externalId:String(u.id),username:u.login};
}
