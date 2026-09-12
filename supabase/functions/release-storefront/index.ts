import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const cors={"access-control-allow-origin":"*","access-control-allow-headers":"content-type","access-control-allow-methods":"GET,OPTIONS"};
function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,"content-type":"application/json","cache-control":"public, max-age=30, stale-while-revalidate=120"}})}
function adminClient(){const url=Deno.env.get("SUPABASE_URL");const secretJson=Deno.env.get("SUPABASE_SECRET_KEYS");const legacy=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");const key=secretJson?JSON.parse(secretJson)?.default:legacy;if(!url||!key)throw new Error("Storefront backend unavailable");return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})}

Deno.serve(async(req:Request)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="GET")return json({error:"Method Not Allowed"},405);
  try{
    const supabase=adminClient();
    const {data,error}=await supabase.from("release_products")
      .select("id,slug,artist_name,artist_type,title,product_type,description,presale_price_cents,release_price_cents,currency,release_at,status,published_at,cover_art_bucket,cover_art_path,stripe_payment_link_url,is_featured,featured_at")
      .eq("storefront_enabled",true)
      .in("status",["live","presale"])
      .not("published_at","is",null)
      .order("is_featured",{ascending:false})
      .order("featured_at",{ascending:false,nullsFirst:false})
      .order("published_at",{ascending:false})
      .limit(20);
    if(error)throw error;
    const base=Deno.env.get("SUPABASE_URL")!;
    // Defense-in-depth: never expose sandbox releases or Stripe test links publicly,
    // even if a bad row is accidentally marked storefront_enabled/live.
    const publicData=(data??[]).filter((r:any)=>{
      const link=String(r.stripe_payment_link_url??"");
      const title=String(r.title??"");
      const slug=String(r.slug??"");
      // Stripe test Payment Links use /test_… on buy.stripe.com (also match buy.stripe.com/test).
      return !/\/test_/i.test(link) && !/buy\.stripe\.com\/test/i.test(link) && !/sandbox/i.test(title) && !/sandbox/i.test(slug);
    });
    const releases=publicData.map((r:any)=>({
      id:r.id,slug:r.slug,artist_name:r.artist_name,artist_type:r.artist_type??null,title:r.title,product_type:r.product_type,description:r.description,
      price_cents:r.status==="presale"&&r.presale_price_cents!=null?r.presale_price_cents:(r.release_price_cents??r.presale_price_cents),
      release_price_cents:r.release_price_cents,presale_price_cents:r.presale_price_cents,currency:r.currency??"usd",release_at:r.release_at,status:r.status,published_at:r.published_at,is_featured:!!r.is_featured,featured_at:r.featured_at,
      cover_url:r.cover_art_bucket==="release-public"&&r.cover_art_path?`${base}/storage/v1/object/public/release-public/${r.cover_art_path}`:null,
      checkout_url:r.stripe_payment_link_url||null,
      support_enabled:true
    })).filter((r:any)=>r.cover_url&&r.checkout_url&&Number(r.price_cents)>0);
    return json({releases,featured:releases.find((r:any)=>r.is_featured)??releases[0]??null});
  }catch(e){console.error(e);return json({error:e instanceof Error?e.message:String(e)},500)}
});
