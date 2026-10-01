import type { RecordingInfo, RecordingLibrary } from '@/recording/library/recording-library';

/**
 * Put a session in a library as a tab that died would have left it: its entry and the bytes of
 * its file, with no opening left. The library times the entry itself.
 */
export async function seedRecording(
  library: RecordingLibrary,
  info: RecordingInfo,
  bytes: Uint8Array
): Promise<void> {
  const { file } = await library.create(info);
  await file.write(0, bytes);
  await file.close();
}
