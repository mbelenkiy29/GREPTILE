import {providerOrigin} from './credentials';
export function githubEnterpriseEndpoints(instance:string){
 const allowed=providerOrigin(instance),u=new URL(allowed);
 if(!['/','/api/v3'].includes(u.pathname))throw new Error('GitHub Enterprise instance must be its root or API root');
 const cloud=/^(?:api\.)?([a-z0-9-]+)\.ghe\.com$/i.exec(u.hostname);
 if(cloud){if(u.pathname!=='/'||u.port)throw new Error('Dedicated GitHub Cloud instance requires its root HTTPS URL');const api=providerOrigin('https://api.'+cloud[1]+'.ghe.com');return {api,web:'https://'+cloud[1]+'.ghe.com'};}
 return {api:u.origin+'/api/v3',web:u.origin};
}
export function githubWebOrigin(api:string){
 const u=new URL(api);if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash)throw new Error('Invalid GitHub API origin');
 if(u.origin==='https://api.github.com'&&u.pathname==='/')return 'https://github.com';
 const cloud=/^api\.([a-z0-9-]+)\.ghe\.com$/i.exec(u.hostname);if(cloud&&u.pathname==='/'&&!u.port)return 'https://'+cloud[1]+'.ghe.com';
 if(u.pathname.replace(/\/$/,'')==='/api/v3')return u.origin;
 throw new Error('Unsupported GitHub API root');
}
