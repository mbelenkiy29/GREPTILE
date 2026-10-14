export async function connectWorkspace(invokeRemote,code){
 if(!/^[a-f0-9]{64}$/.test(code))throw new Error("Enter the 64-character authorization code from OpenReview.");
 const response=await invokeRemote({path:"/api/bitbucket/forge/connect",method:"POST",headers:{"content-type":"application/json"},body:{code}});
 if(response.status!==200||!response.body?.connectionId||!["suspended","connected"].includes(response.body.status))throw new Error("Connection failed. Check workspace owner access and create a fresh authorization code in OpenReview.");
 return response.body;
}

export async function linkPersonalIdentity(invokeRemote,code){
 if(!/^[a-f0-9]{64}$/.test(code))throw new Error("Enter the personal authorization code from OpenReview.");
 const response=await invokeRemote({path:"/api/bitbucket/forge/identity",method:"POST",headers:{"content-type":"application/json"},body:{code}});
 if(response.status!==200||response.body?.status!=="linked"||!Number.isFinite(response.body.expiresAt))throw new Error("Personal confirmation failed.");
 return response.body;
}
