import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { NodeSDK } from "@opentelemetry/sdk-node";

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  const sdk = new NodeSDK({ serviceName: "flashdrop-api", traceExporter: new OTLPTraceExporter(), instrumentations: [getNodeAutoInstrumentations()] });
  sdk.start();
  process.once("SIGTERM", () => void sdk.shutdown());
  process.once("SIGINT", () => void sdk.shutdown());
}
