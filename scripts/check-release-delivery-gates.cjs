const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const {stripTypeScriptTypes} = require('node:module');
const {webcrypto} = require('node:crypto');
const source = stripTypeScriptTypes(fs.readFileSync('supabase/functions/release-download/index.ts','utf8').replace(/^import .*;\n/gm,''));
async function probe(overrides = {}) {
  const past = new Date(Date.now()-60000).toISOString(), future = new Date(Date.now()+60000).toISOString();
  const data = {
    release_download_tokens:{id:'token',entitlement_id:'entitlement',expires_at:future,max_downloads:3,download_count:0,revoked_at:null},
    release_entitlements:{id:'entitlement',status:'available',available_at:past,product_id:'release',order_id:'order'},
    release_products:{storage_bucket:'release-private',storage_object_path:'release/album.zip',delivery_filename:'album.zip',release_at:past},
    release_orders:{payment_status:'paid'}, ...overrides,
  };
  let handler, signed = 0;
  const client = {
    from(table) {
      const query = {select(){return this},eq(){return this},update(){return this},insert(){return this},
        maybeSingle:async()=>({data:data[table],error:null}), single:async()=>({data:data[table],error:null}),
        then(resolve){resolve({data:null,error:null})}};
      return query;
    },
    storage:{from:()=>({createSignedUrl:async()=>{signed++;return{data:{signedUrl:'https://example.test/private-audio'},error:null}}})},
  };
  vm.runInNewContext(source,{Deno:{env:{get:()=> 'test'},serve:fn=>handler=fn},createClient:()=>client,Response,Request,URL,TextEncoder,crypto:webcrypto,console});
  const response = await handler(new Request('https://example.test/download?token=test-token'));
  return {status:response.status,signed,body:response.status===302?null:await response.json()};
}
(async()=>{
  const future = new Date(Date.now()+3600000).toISOString();
  let r = await probe({release_products:{storage_bucket:'release-private',storage_object_path:'ep.zip',release_at:future}});
  assert.equal(r.status,403);assert.equal(r.body.error,'release_locked');assert.equal(r.signed,0);
  r = await probe({release_orders:{payment_status:'refunded'}});assert.equal(r.status,403);assert.equal(r.signed,0);
  r = await probe({release_orders:null});assert.equal(r.status,403);assert.equal(r.signed,0);
  r = await probe({release_entitlements:{status:'locked',available_at:future}});assert.equal(r.status,403);assert.equal(r.signed,0);
  r = await probe({release_products:{release_at:new Date(Date.now()-60000).toISOString()}});assert.equal(r.status,503);assert.equal(r.signed,0);
  r = await probe({release_download_tokens:{expires_at:new Date(Date.now()-60000).toISOString()}});assert.equal(r.status,410);assert.equal(r.signed,0);
  r = await probe();assert.equal(r.status,302);assert.equal(r.signed,1);
  console.log('PASS: current release date blocks early entitlement; unpaid/refunded/missing orders denied; locked/expired/missing-package denied; paid and due redirects to private download.');
})().catch(e=>{console.error(e);process.exitCode=1});
