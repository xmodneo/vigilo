/**
 * The durable input reservation is the UTF-8 size of the complete stateless
 * Interactions request. It is a conservative accounting unit, not a tokenizer
 * measurement. The 256 KiB ceiling leaves one full 128 KiB bounded context
 * result plus 128 KiB for instructions, prior turns and JSON framing. Further
 * accumulated history fails closed before a provider request.
 */
export const MAX_GEMINI_SERIALIZED_REQUEST_BYTES = 256 * 1024;
