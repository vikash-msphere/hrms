// The SPA's view of the wire types. Everything real lives in src/http/wire.ts, which the serializers annotate
// themselves with - so the shapes here are not "the client's belief about the API", they are the same types
// the server is compiled against. A field the server stops sending breaks this build too.
export type { Wire, Embed, Item } from "../../src/http/wire";
