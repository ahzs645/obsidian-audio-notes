import { request, requestUrl } from "obsidian";
import { Buffer } from "buffer";

export interface ScriberrConfig {
	baseUrl: string;
	apiKey: string;
	profileName?: string;
}

export interface ScriberrJob {
	id: string;
	status: "uploaded" | "pending" | "processing" | "completed" | "failed" | string;
	transcript?: string;
	error_message?: string;
	title?: string;
}

export interface ScriberrTranscriptSegment {
	id?: number;
	start?: number | string;
	end?: number | string;
	text?: string;
}

export interface ScriberrTranscriptResponse {
	text?: string;
	segments?: ScriberrTranscriptSegment[];
	[key: string]: unknown;
}

export interface ScriberrQuickJobRequest {
	audio: ArrayBuffer | Buffer;
	filename: string;
	mimeType?: string;
	parameters?: Record<string, unknown>;
	profileName?: string;
}

export interface ScriberrSubmitJobRequest extends ScriberrQuickJobRequest {
	title?: string;
	model?: string;
	language?: string;
	diarization?: boolean;
}

export interface ScriberrPollOptions {
	pollIntervalMs?: number;
	timeoutMs?: number;
}

interface MultipartFilePart {
	field: string;
	filename: string;
	contentType?: string;
	data: Buffer;
}

export class ScriberrClient {
	private readonly baseUrl: string;

	constructor(private config: ScriberrConfig) {
		if (!config.baseUrl) {
			throw new Error("Scriberr base URL is required");
		}
		if (!config.apiKey) {
			throw new Error("Scriberr API key is required");
		}
		this.baseUrl = ScriberrClient.normalizeBaseUrl(config.baseUrl);
	}

	static isConfigured(
		config?: Partial<ScriberrConfig>
	): config is ScriberrConfig {
		return Boolean(config?.baseUrl && config?.apiKey);
	}

	private static normalizeBaseUrl(url: string): string {
		const trimmed = url.trim().replace(/\/+$/, "");
		return trimmed || "https://localhost:8080/api/v1";
	}

	private buildUrl(path: string): string {
		if (!path) {
			return this.baseUrl;
		}
		if (path.startsWith("http://") || path.startsWith("https://")) {
			return path;
		}
		if (path.startsWith("/")) {
			return `${this.baseUrl}${path}`;
		}
		return `${this.baseUrl}/${path}`;
	}

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			Accept: "application/json",
			"X-API-Key": this.config.apiKey,
		};
		return headers;
	}

	private static toBuffer(data: ArrayBuffer | Buffer): Buffer {
		if (Buffer.isBuffer(data)) {
			return data;
		}
		return Buffer.from(data);
	}

	private static bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
		return buffer.buffer.slice(
			buffer.byteOffset,
			buffer.byteOffset + buffer.byteLength
		);
	}

	private static buildMultipartBody(
		fields: Record<string, string | number | boolean | undefined>,
		file?: MultipartFilePart
	): { body: ArrayBuffer; contentType: string } {
		const boundary = `----ScriberrBoundary${Date.now().toString(16)}`;
		const CRLF = "\r\n";
		const chunks: Buffer[] = [];

		const appendString = (value: string) => {
			chunks.push(Buffer.from(value, "utf8"));
		};

			for (const [name, rawValue] of Object.entries(fields)) {
				const isEmptyString =
					typeof rawValue === "string" && rawValue.length === 0;
				if (rawValue === undefined || rawValue === null || isEmptyString) {
					continue;
				}
				appendString(`--${boundary}${CRLF}`);
			appendString(
				`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`
			);
			appendString(String(rawValue));
			appendString(CRLF);
		}

		if (file) {
			appendString(`--${boundary}${CRLF}`);
			appendString(
				`Content-Disposition: form-data; name="${file.field}"; filename="${file.filename}"${CRLF}`
			);
			appendString(
				`Content-Type: ${file.contentType || "application/octet-stream"}${CRLF}${CRLF}`
			);
			chunks.push(file.data);
			appendString(CRLF);
		}

		appendString(`--${boundary}--${CRLF}`);
		const buffer = Buffer.concat(chunks);
		return {
			body: ScriberrClient.bufferToArrayBuffer(buffer),
			contentType: `multipart/form-data; boundary=${boundary}`,
		};
	}

	async submitQuickJob(
		params: ScriberrQuickJobRequest
	): Promise<ScriberrJob> {
		const fields: Record<string, string> = {};
		if (params.parameters && Object.keys(params.parameters).length > 0) {
			fields.parameters = JSON.stringify(params.parameters);
		}
		if (params.profileName) {
			fields.profile_name = params.profileName;
		}

		const file: MultipartFilePart = {
			field: "audio",
			filename: params.filename,
			contentType: params.mimeType || "application/octet-stream",
			data: ScriberrClient.toBuffer(params.audio),
		};

		return this.postMultipart("/transcription/quick", fields, file);
	}

	async submitJob(params: ScriberrSubmitJobRequest): Promise<ScriberrJob> {
		const fields: Record<string, string | boolean | undefined> = {
			title: params.title,
			model: params.model,
			language: params.language,
			diarization:
				params.diarization !== undefined
					? String(params.diarization)
					: undefined,
		};
		if (params.parameters && Object.keys(params.parameters).length > 0) {
			fields.parameters = JSON.stringify(params.parameters);
		}
		const file: MultipartFilePart = {
			field: "audio",
			filename: params.filename,
			contentType: params.mimeType || "application/octet-stream",
			data: ScriberrClient.toBuffer(params.audio),
		};
		return this.postMultipart("/transcription/submit", fields, file);
	}

	async fetchQuickJob(id: string): Promise<ScriberrJob> {
		return this.get(`/transcription/quick/${id}`);
	}

	async fetchJob(id: string): Promise<ScriberrJob> {
		return this.get(`/transcription/${id}`);
	}

	async waitForQuickJob(
		id: string,
		options?: ScriberrPollOptions
	): Promise<ScriberrJob> {
		return this.pollUntilComplete(() => this.fetchQuickJob(id), options);
	}

	async waitForJob(
		id: string,
		options?: ScriberrPollOptions
	): Promise<ScriberrJob> {
		return this.pollUntilComplete(() => this.fetchJob(id), options);
	}

	async fetchTranscript(id: string): Promise<ScriberrTranscriptResponse> {
		return this.get(`/transcription/${id}/transcript`);
	}

	private async pollUntilComplete(
		fetcher: () => Promise<ScriberrJob>,
		options?: ScriberrPollOptions
	): Promise<ScriberrJob> {
		const pollIntervalMs = options?.pollIntervalMs ?? 3000;
		const timeoutMs = options?.timeoutMs ?? 5 * 60 * 1000;
		const start = Date.now();

		while (true) {
			const job = await fetcher();
			if (job.status === "failed") {
				throw new Error(job.error_message || "Scriberr job failed");
			}
			if (job.status === "completed") {
				return job;
			}
			if (Date.now() - start > timeoutMs) {
				throw new Error("Timed out while waiting for Scriberr job");
			}
			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}
	}

	private async postMultipart(
		path: string,
		fields: Record<string, string | number | boolean | undefined>,
		file: MultipartFilePart
	): Promise<ScriberrJob> {
		const { body, contentType } = ScriberrClient.buildMultipartBody(
			fields,
			file
		);

		const response = await request({
			url: this.buildUrl(path),
			method: "POST",
			headers: this.buildHeaders(),
			contentType,
			body,
		});
		return JSON.parse(response) as ScriberrJob;
	}

	private async get<T = any>(path: string): Promise<T> {
		const response = await request({
			url: this.buildUrl(path),
			method: "GET",
			headers: this.buildHeaders(),
		});
		return JSON.parse(response) as T;
	}
}

export async function downloadAudioToArrayBuffer(
	url: string
): Promise<ArrayBuffer> {
	const response = await requestUrl({ url, method: "GET" });
	return response.arrayBuffer;
}
