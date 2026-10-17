import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { BotPairings } from "../src/pairing.js";
import { verifyTelegramInitData } from "../src/telegram.js";
import { initData, TOKEN, NOW } from "./helpers.js";
const stores:BotPairings[]=[];
afterEach(()=>{stores.splice(0).forEach(s=>s.close());});
const digest=(token:string)=>createHash("sha256").update(Buffer.from(token,"hex")).digest("hex");
const raw=(user=42,date=NOW)=>initData(user,date,{signature:"synthetic-signature-owner-must-independently-reject"});
function setup(){let now=NOW;const store=new BotPairings(s=>verifyTelegramInitData(s,TOKEN,{nowSeconds:now}),()=>now);stores.push(store);return {store,time:(n:number)=>{now=n;}};}
it("consumes a code in one browser while preserving exact retry after a lost claim response",()=>{
 const {store}=setup(),token="ab".repeat(32),code=`GLP1.12345.42.${token}`,hash=digest(token),claimId="cd".repeat(32);
 const created=store.create(raw(),hash);expect(created).toEqual({botId:"12345",userId:"42",expiresAt:NOW+120});
 expect(store.create(raw(),hash)).toEqual(created);
 expect(()=>store.create(raw(43),hash)).toThrow(/rebound/);
 expect(()=>store.claim(code,"bad")).toThrow();expect(()=>store.claim(code.replace(".42.",".43."),claimId)).toThrow();
 expect(store.claim(code,claimId)).toEqual({initData:raw(),expiresAt:NOW+120});
 expect(store.claim(code,claimId)).toEqual({initData:raw(),expiresAt:NOW+120});
 expect(()=>store.claim(code,"ef".repeat(32))).toThrow(/claimed/);
 const reference={tokenHash:hash,claimId},request={requestKey:"01".repeat(32),appId:"1",home:"home",sessionExpirySlot:"900"};
 store.authorizeReference(reference,raw(),request);
 expect(()=>store.authorizeReference(reference,raw(),{...request,home:"other"})).toThrow(/replaced/);
 expect(()=>store.authorizeReference(reference,raw(43))).toThrow();
 store.link(reference,raw(),"12".repeat(32));expect(store.status(raw(),hash)).toMatchObject({state:"linked",consentId:"12".repeat(32)});
 expect(()=>store.link(reference,raw(),"13".repeat(32))).toThrow(/linked/);
 expect(()=>store.status(raw(43),hash)).toThrow();
});
it("bounds credential lifetime, retained metadata, capacity, restarts and clock regression",()=>{
 const {store,time}=setup(),tokens=["01","02","03","04"].map(x=>x.repeat(32));
 tokens.slice(0,3).forEach(t=>store.create(raw(),digest(t)));expect(()=>store.create(raw(),digest(tokens[3]!))).toThrow(/capacity/);
 const code=`GLP1.12345.42.${tokens[0]}`,claimId="ab".repeat(32);store.claim(code,claimId);
 time(NOW+120);expect(()=>store.claim(code,claimId)).toThrow();expect(store.status(raw(),digest(tokens[0]!)).state).toBe("claimed");
 expect(()=>store.status(raw(),digest(tokens[1]!))).toThrow();
 time(NOW+300);expect(()=>store.status(raw(),digest(tokens[0]!))).toThrow();
 time(NOW+299);expect(()=>store.create(raw(),digest(tokens[3]!))).toThrow(/unavailable/);
 const fresh=setup().store;expect(()=>fresh.claim(code,claimId)).toThrow();fresh.close();expect(()=>fresh.create(raw(),digest(tokens[3]!))).toThrow();
});
