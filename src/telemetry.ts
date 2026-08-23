import { context, propagation, SpanStatusCode, trace } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const tracer = trace.getTracer("bee-slack");
let sdk: NodeSDK | undefined;

export interface TelemetryCarrier {
	traceparent?: string;
	tracestate?: string;
	baggage?: string;
}

export function initializeTelemetry(): void {
	if (process.env.OTEL_SDK_DISABLED?.toLowerCase() === "true" || sdk) return;
	const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
	const configuredTraceEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
	if (!baseEndpoint && !configuredTraceEndpoint) return;
	const traceEndpoint = configuredTraceEndpoint || `${baseEndpoint?.replace(/\/$/, "") || ""}/v1/traces`;
	sdk = new NodeSDK({
		resource: resourceFromAttributes({
			[ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || "bee-slack",
			"deployment.environment": process.env.OTEL_DEPLOYMENT_ENVIRONMENT || "unknown",
		}),
		traceExporter: new OTLPTraceExporter({ url: traceEndpoint }),
	});
	sdk.start();
}

export async function shutdownTelemetry(): Promise<void> {
	const activeSdk = sdk;
	sdk = undefined;
	await activeSdk?.shutdown();
}

export function dispatchTracedTurn(
	attributes: Record<string, string | undefined>,
	dispatch: (carrier: TelemetryCarrier) => void,
): void {
	tracer.startActiveSpan("slack.turn", { attributes }, (span) => {
		try {
			const carrier: TelemetryCarrier = {};
			propagation.inject(context.active(), carrier);
			dispatch(carrier);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			span.recordException(error instanceof Error ? error : new Error(message));
			span.setStatus({ code: SpanStatusCode.ERROR, message });
			throw error;
		} finally {
			span.end();
		}
	});
}

export async function withTracedTurn<T>(
	name: string,
	attributes: Record<string, string | undefined>,
	run: (carrier: TelemetryCarrier) => Promise<T>,
): Promise<T> {
	return tracer.startActiveSpan(name, { attributes }, async (span) => {
		try {
			const carrier: TelemetryCarrier = {};
			propagation.inject(context.active(), carrier);
			return await run(carrier);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			span.recordException(error instanceof Error ? error : new Error(message));
			span.setStatus({ code: SpanStatusCode.ERROR, message });
			throw error;
		} finally {
			span.end();
		}
	});
}
