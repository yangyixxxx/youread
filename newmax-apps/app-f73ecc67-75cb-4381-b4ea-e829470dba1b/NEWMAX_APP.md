# Newmax Local App Access Standard

This capsule follows `newmax.local-app@2026.09`.

## Compatibility Contract

- The app may call Newmax only through `window.newmaxApp`.
- The app must not import Newmax renderer, Electron, IPC, or main-process internals.
- Runtime capabilities must be declared in `newmax.app.json.permissions`.
- Runtime API compatibility follows semver through `newmax.app.json.runtime`.
- Newmax upgrades must keep compatible runtime methods working for the declared range.
- If a runtime capability changes incompatibly, the manifest standard version must change and a migration note must be added here.

## Phone Image Capture (Optional)

Declare `phone.capture` and `files.appData` permissions to use `window.newmaxApp.capture`.
Subscribe to `capture.onEvent` before starting. On an explicit user action, call `capture.start({ context: recordId, address? })` and display its `qrDataUrl` and expiry. Phone users on the same trusted Wi-Fi can take photos or upload multiple images without a mobile app. HTTP traffic is not encrypted; no cloud relay or automatic AI call is involved.
For optional HTTPS continuous camera capture, also declare `phone.capture.remote` and use `capture.start({ context: recordId, transport: 'relay' })` after an explicit user choice. Explain that images transit Newmax's relay in memory before local saving. This requires login and a configured capture service; report unavailability instead of silently falling back. Secure pages offer a persistent camera preview with repeated shutters and serial uploads; HTTP LAN pages keep the native camera/album fallback.
Handle `image`, `connected` and `closed` events. Persist each image's `id` with your record, deduplicate events, and restore via `capture.listImages()` (latest 100). `capture.readImage(id)` returns the received image as a data URL; `thumbnailDataUrl` is suitable for lists. Call `capture.stop(session.id)` and unsubscribe when the receiving UI closes. Supported formats: JPEG, PNG; 20 MB and 50 megapixels per image, 100 images / 200 MB per 15-minute session. HEIC must be exported as JPEG. Camera-preview captures are JPEG frames with a maximum 4096-pixel long edge, not original camera files; album uploads remain unchanged. No automatic OCR or perspective correction is provided.


## Product identity

Users can change the name and icon in the app conversation's App settings. Keep the app id and data directory stable.
Read the current name/icon from await window.newmaxApp.app.getBootstrap(); bootstrap.iconUrl is an image URL for <img> when the icon has one (generated or uploaded icons). Subscribe with app.onChanged(bootstrap => ...) to update product headers/icons without losing unsaved work; the method returns an unsubscribe function.
Manifest icon accepts a generated icon token symbol:<glyph>:<palette> (preferred; see the glyph and palette lists), a NewMax design icon name, or a PNG data URL (maximum 350,000 characters). Do not insert a URL/path into this field. Never reset user-selected branding during previews. Renaming metadata does not rewrite hardcoded strings in existing app source; use bootstrap metadata for product branding.

## Media runtime

Use window.newmaxApp.media for runtime image, speech, transcription and text-to-video requests. Declare ai.media and files.appData permissions. New apps include them; old apps can enable media in App settings. Respect a user's disabled permission.
await sdk.media.listModels() returns {image,speech,transcribe,video}; each has {available,defaultModel:{providerId,model}|null,models:[{providerId,providerName,model,voices?}]} from live host settings, without secrets. "available" means a default is configured, not a health/balance check. Transcription includes the installed local SenseVoice model. Cloud models, including NewMax Provider, reuse host configuration. Never hardcode a provider, key or endpoint.
await sdk.media.generateImage({prompt,providerId?,model?,aspectRatio?,size?,referenceImages?:[{mediaType,data:base64}]});
await sdk.media.generateSpeech({text,voice?,providerId?,model?});
await sdk.media.transcribe({audio:{mediaType,data:base64},language?,providerId?,model?});
await sdk.media.generateVideo({prompt,durationSec?,ratio?,providerId?,model?}); // text-to-video, not video editing
Results are {ok:true,providerId,model,assets?:[{id,path,url,mimeType,bytes}],text?} or {ok:false,code,error}. Persist asset paths/URLs in the app's records; url is a local file URL usable in img/audio/video elements. Generated files are saved under this app's data/media directory and removed when the app is deleted. Input uploads are temporary and do not enter global transcription history.
Omit providerId/model to follow the current host default; explicit selections must come from the matching capability catalog. Chat models and image-generation models are different catalogs. Never use ai.chat as a substitute for a media-generation endpoint. Missing configuration is an error, not permission to silently switch vendors. Old runtimes may not expose sdk.media: feature-detect before calling it.
Media calls require an explicit user action. Disclose that cloud requests send content to that provider and may consume credits. Disable duplicate submits and show pending/error states: one media request per app runs at a time. Do not auto-retry a failed/timed-out generation because a provider may already have billed it. There is no cancellation API; closing the app does not guarantee cancellation of a submitted remote job.
Limits: prompt/text 20,000 characters; up to four PNG/JPEG/WebP reference images, 10 MB each; audio upload up to 25 MB (WAV/MP3/M4A/WebM/Ogg/FLAC). Strip data-URL prefixes before supplying base64. Store original phone images via capture APIs; transcription is speech-to-text, not OCR. Use ai.chat({images}) with a vision-capable model for OCR.


## Required Files

- `newmax.app.json`: identity, runtime range, permissions, shortcuts, build metadata.
- `REQUIREMENTS.md`: user-visible product requirements and assumptions.
- `BUILD_PLAN.md`: visible construction trace, app structure, and future edit protocol.
- `ACCEPTANCE.md`: verification checklist for this app.
- `DESIGN_SYSTEM.md`: local UI and interaction rules.
- `src/`: frontend source.
- `backend/`: reserved backend action boundary.

## Change Protocol

When Newmax edits this app:

1. Read `newmax.app.json`, this file, `REQUIREMENTS.md`, `BUILD_PLAN.md`, and `ACCEPTANCE.md` first.
2. Update requirements before changing behavior.
3. Update the build plan with the files and checks that will change.
4. Keep runtime calls behind `window.newmaxApp`.
5. Run the smallest meaningful validation available.
6. Record any remaining manual checks in `ACCEPTANCE.md`.
