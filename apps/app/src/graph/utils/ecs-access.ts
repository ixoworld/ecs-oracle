/**
 * ECS data-access whitelist.
 *
 * The ECS Oracle skill is the only path from the oracle to the SupaMoto
 * business data. We gate it at two layers, both anchored here:
 *
 *   1. The system prompt only describes the ecs-oracle skill to whitelisted
 *      users (so the agent doesn't autonomously suggest it to others).
 *   2. The ECS_MCP_URL / ECS_MCP_AUTH_TOKEN oracle secrets are only injected
 *      into the sandbox `x-os-*` headers for whitelisted users, so even if a
 *      non-whitelisted user explicitly invokes the skill, fetch.mjs will exit
 *      with MISSING_SECRET rather than hitting the ECS server.
 *
 * This is a temporary measure until the ECS server enforces auth via UCAN.
 * When that lands, the whitelist disappears and the gate becomes per-DID
 * delegation chains validated by the server.
 */

/**
 * DIDs allowed to use the ecs-oracle skill. Add or remove here only —
 * never duplicate this list anywhere else in the codebase.
 */
const ALLOWED_ECS_DIDS: ReadonlySet<string> = new Set([
  'did:ixo:ixo1tfcltwvk35s6jdsxs09u5mqkrx5u0n3vu2vqgy', // mike
  'did:ixo:ixo1zem4acd0tudd0p8jf4x3nunt4h86sxnxsf0z0s', // mike
  'did:ixo:ixo1nc6sygtv4jzdsssg2xjzmuszk9uhe2jnf970sd', // mike
  'did:ixo:ixo1yxsut3tguvc65ud55zh3mgeveu06e0m6t5ulsf', // mike
  'did:ixo:ixo12am7v5xgjh72c7xujreyvtncqwue3w0v6ud3r4', // mike (alice)
  'did:ixo:ixo1ujxelhkaf0hnuhm0fhdsy6c3fy5rdwtk4nhnr6', // Graeme Test
  'did:ixo:ixo1v8ewsaavpavc9r44n6x6efknhscz56fp5k7a9m', // Graeme Main
  'did:ixo:ixo1qnh30usjtw2dujxphy805x2af6fhn5zmfhy2v9', // Graeme
  'did:x:zQ3shNGDBopWqD2byBcyo5dHeS5ggKE3bJyqRFKUfWLGPq2J4', // Graeme Main
  'did:ixo:ixo1aqrxzvwdw7wqh27jafc60j5ny9gyjcuewrvfp5', // Alwyn Test
  'did:ixo:ixo1aqrxzvwdw7wqh27jafc60j5ny9gyjcuewrvfp5', // Alwyn Main
  'did:ixo:ixo1hldfmx3h7hujfgty0mmykmvmh6cj8d8ptalfun', // Alwyn
  'did:ixo:ixo1latzweagqawv6cr3pdlkuvzetll35rlyfzd7nr', // Bupe Test
  'did:ixo:ixo16045372qxdvtyrh9at8tsm7zfskxqey8lw6nmg', // Bupe Test
  'did:x:zQ3shqitrJkJshfb6XSGLyALr3snt8XyAaDUEf1WEaHX8qqcW', // Bupe Main
  'did:ixo:ixo1zhjm7letn3f64jql7mewatn679zervxngy8acg', // Joshua Test
  'did:ixo:ixo1wrgdf0y9y6pz0vmz9vxk43l7dq7qu4xeel8hkz', // Annie Test
  'did:ixo:ixo1wrgdf0y9y6pz0vmz9vxk43l7dq7qu4xeel8hkz', // Joshua Test
  'did:ixo:ixo1vuv0sqv3dnwsc60g04pmwtn9xt2f0jvjjjncdu', // Loveness Test
  'did:ixo:ixo1u9ufzd4adw9xc0cymn53jas3zlxf4q6nxvy0e9', // Mike local
  'did:ixo:ixo1d82np5420yfa2nqwczgqkukgves49alv3v5uag', // Alwyn
  'did:ixo:ixo1m30l6lnw2nxuhhluwq7r0xw39l4mwy98xcpc96', // Joshua
  'did:ixo:ixo1ym5fc0m0gnggh0zde69qpmd9fnlxk75zrulj6c', // Annie
  'did:ixo:ixo1hcw9z35r5x2vjvpt57q865lt0qwqtedh79rlj0', // Bupe
  'did:ixo:ixo1tndv5ev5f2wyak0wdaxqfgjay3vg3jegfq0lcn', // Mosho
  'did:ixo:ixo139le0z4tum5wauac9xs4jj39zulf8umqyx60xv', // Evans Kalunga
  'did:ixo:ixo1hpe7t47zwz4p4a8s6dsuqhz702h4ar28qs3hc4', // Josephine Chime
  'did:ixo:ixo1n3jplcy9htchsv67ll92a426kxchqd56yu3z0f', // Cherister Choongo
  'did:ixo:ixo15ej8r2gd6a0x95z74ys0zkha9uqzg5kxnpemzy', // Christine Hill
  'did:ixo:ixo1erj3wzva95stz8reht7rqsma2ka8lanepelw2q', // Mattias Ohlson
  'did:ixo:ixo1rpm9fz3vkcdlnagchawjytzkjjcqlmwamz8vnf', // Towela Nyrienda
  'did:ixo:ixo1xatjpmm2kw4ujfyqzhucrmgp8prxu6au6mvhqr', // Marion Peterson
  'did:ixo:ixo19yr5c894mnhtnr2dm676y04j58p9jupk2nfnu3', // George Kalipenta
  'did:ixo:ixo1079guw4qpz8ymcfp6vcunf8gzxu5u3clggdc8e', // Chipo Bukowa
  'did:ixo:ixo1gxshyw8lcz8wvu2s5waq0plqcu5ftu2sfhwag4', // Edina Kayewa
  'did:ixo:ixo1sv72qcpzz7hjn9cf654vrzyvd983hz6tjagh0w', // Mercy Mbozi
  'did:ixo:ixo18fsl6l2fnw2gtady92nkpa975aqstdmgjgusfk', // Maclaud Nchimunya
  'did:ixo:ixo1dy2xhvvgwgslnvpf7dwevlzd3ug2ya08xezvc9', // Talopa Zulu
  'did:ixo:ixo1ghqgl9qdd3rydpwp5chgras3hz8q6qkhryl93x', // Chella Kamina
  'did:ixo:ixo1pjshp5vr6es5pagwyp97nrhh6ax2jepnemken0', // Harrison Teteka
  'did:ixo:ixo1paf4a2c6kz9ndmhv5lv6hw4wrkxhrvehqwuyn3', // Nancy Katongo
  'did:ixo:ixo1g39e9ehxtzqr3au6lqdlvawfyxcsgzy8flxamh', // Thandiwe Lungu
  'did:ixo:ixo19el3sd7cyjzjap4scsg4x9f0fwdctp5vecjcxu', // Mumba Chabwe
  'did:ixo:ixo1km8c4fpuh8zz6v53cpfcqllyeenyy2yawaxfsy', // Samuel Mulala
  'did:ixo:ixo1cc0nqnnatxwqnwamz9pxhy754yklxvxsvm6vmh', // Chikondi Nanyangwe
  'did:ixo:ixo1r06rh8z68geq9pdwrnts39gyk5sptppfne0tef', // Ebba Perbeck
  'did:ixo:ixo1ay6upt9459drkd2x7l3mpvedc0n9tqefywqhy3', // Duncan Phiri
  'did:ixo:ixo16ugu3hsfnuk80jvazgttlaw48h8se6teuz3v80', // Loveness Chibwe
  'did:ixo:ixo1vd0kwtt8kqh93mk6jde9evs24uf038lswh86es', // Joshua
]);

/** True iff this user DID may use the ecs-oracle skill. */
export function isEcsAuthorized(userDid: string | undefined | null): boolean {
  if (!userDid) return false;
  return ALLOWED_ECS_DIDS.has(userDid);
}
