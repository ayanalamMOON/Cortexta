import { contextRouter } from "./context";
import { contextStreamRouter } from "./context-stream";
import { cxlinkRouter } from "./cxlink";
import { evolveRouter } from "./evolve";
import { ingestRouter } from "./ingest";
import { metaRouter } from "./meta";
import { queryRouter } from "./query";
import { versionRouter } from "./version";

export function registerPublicDaemonRoutes(app: any): void {
    app.use("/", versionRouter);
    app.use("/", metaRouter);
}

export function registerProtectedDaemonRoutes(app: any): void {
    app.use("/ingest", ingestRouter);
    app.use("/query", queryRouter);
    app.use("/context", contextRouter);
    app.use("/context/stream", contextStreamRouter);
    app.use("/cxlink", cxlinkRouter);
    app.use("/evolve", evolveRouter);
}

export function registerDaemonRoutes(app: any): void {
    registerPublicDaemonRoutes(app);
    registerProtectedDaemonRoutes(app);
}
