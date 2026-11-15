import { initializeApp, getApps } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  signOut,
  GoogleAuthProvider,
  onAuthStateChanged,
  User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

// Initialize primary Firebase app (for Studio user auth) and a separate named app
// for Google Drive export OAuth so Drive sign-in/sign-out never mutates the main session.
const app = getApps().find((a) => a.name === '[DEFAULT]') ?? initializeApp(firebaseConfig);
export const auth = getAuth(app);

const DRIVE_APP_NAME = 'google-drive-export';
const driveApp = getApps().find((a) => a.name === DRIVE_APP_NAME) ?? initializeApp(firebaseConfig, DRIVE_APP_NAME);
const driveAuth = getAuth(driveApp);

// Workspace OAuth Scopes configured for this applet
export const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const provider = new GoogleAuthProvider();
provider.addScope(DRIVE_SCOPE);
provider.setCustomParameters({
  prompt: 'consent',
});

// In-memory token cache (NEVER in localStorage/sessionStorage as required by security guidelines)
let cachedAccessToken: string | null = null;
let isSigningIn = false;

export const initDriveAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  return onAuthStateChanged(driveAuth, async (user: User | null) => {
    if (user) {
      if (cachedAccessToken) {
        if (onAuthSuccess) onAuthSuccess(user, cachedAccessToken);
      } else if (!isSigningIn) {
        cachedAccessToken = null;
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      cachedAccessToken = null;
      if (onAuthFailure) onAuthFailure();
    }
  });
};

export const signInWithGoogleDrive = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(driveAuth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Failed to obtain Google Drive access token.');
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error('Google Sign-In failed:', error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const signOutGoogleDrive = async () => {
  await signOut(driveAuth);
  cachedAccessToken = null;
};

export const getDriveAccessToken = async (): Promise<string | null> => {
  return cachedAccessToken;
};

export interface DriveExportResult {
  fileId: string;
  fileName: string;
  webViewLink?: string;
  folderId?: string | null;
}

export interface DriveExportPayload {
  title: string;
  description: string;
  hashtags: string[];
  beatsText: string;
  duration: number;
  sourceType: 'youtube' | 'prompt';
  sourceUrl?: string;
  videoBlob?: Blob;
  srtContent?: string;
}

/**
 * Finds or creates a "Forge Studio Shorts" folder in the user's Google Drive.
 * If folder creation or search fails, gracefully returns null so files are saved directly to My Drive.
 */
export async function getOrCreateForgeDriveFolder(token: string): Promise<string | null> {
  try {
    const query = encodeURIComponent("name = 'Forge Studio Shorts' and mimeType = 'application/vnd.google-apps.folder' and trashed = false");
    const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&spaces=drive`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (searchRes.status === 401) {
      cachedAccessToken = null;
      throw new Error('Your Google authorization has expired. Please sign in with Google again.');
    }

    if (searchRes.ok) {
      const data = await searchRes.json();
      if (data.files && data.files.length > 0) {
        return data.files[0].id;
      }
    }

    // Try creating the folder with minimal body
    const createRes = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Forge Studio Shorts',
        mimeType: 'application/vnd.google-apps.folder',
      }),
    });

    if (createRes.status === 401) {
      cachedAccessToken = null;
      throw new Error('Your Google authorization has expired. Please sign in with Google again.');
    }

    if (createRes.ok) {
      const folder = await createRes.json();
      return folder.id;
    }

    // If folder creation was rejected (e.g. shared drive or policy), log details and fallback to root
    const errText = await createRes.text();
    console.warn(`[Google Drive] Folder creation returned ${createRes.status}, fallback to root drive:`, errText);
    return null;
  } catch (err: any) {
    if (err.message && err.message.includes('expired')) {
      throw err;
    }
    console.warn('[Google Drive] Folder lookup encountered an issue, saving directly to My Drive:', err);
    return null;
  }
}

/**
 * Exports video metadata package (JSON & SRT) directly to Google Drive.
 */
export async function exportShortToGoogleDrive(
  payload: DriveExportPayload,
  onProgress?: (step: string, percent: number) => void
): Promise<DriveExportResult> {
  const token = cachedAccessToken;
  if (!token) {
    throw new Error('Please sign in with Google to export to Google Drive.');
  }

  onProgress?.('Preparing Google Drive destination...', 15);
  const folderId = await getOrCreateForgeDriveFolder(token);

  const sanitizedTitle = payload.title.replace(/[^a-zA-Z0-9\s-_]/g, '').trim() || 'Untitled-Short';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseFileName = `${sanitizedTitle}-${timestamp}`;

  onProgress?.('Uploading publishing package & metadata to Drive...', 45);

  // 1. Upload publishing package file (JSON)
  const metadataPackage = {
    appName: 'Forge Studio',
    title: payload.title,
    description: payload.description,
    hashtags: payload.hashtags,
    durationSeconds: payload.duration,
    aspectRatio: '9:16 Vertical (1080x1920)',
    exportedAt: new Date().toISOString(),
    sourceType: payload.sourceType,
    sourceUrl: payload.sourceUrl || '',
    scriptBeats: payload.beatsText,
    youtubeKeywords: payload.hashtags.map((h) => h.replace('#', '')).join(', '),
  };

  const packageJsonText = JSON.stringify(metadataPackage, null, 2);

  const boundary = 'ForgeStudioBoundary' + Date.now();
  const fileMetadata: Record<string, any> = {
    name: `${baseFileName}-Publishing-Pack.json`,
    mimeType: 'application/json',
    description: `Publishing package for ${payload.title} created with Forge Studio`,
  };

  if (folderId) {
    fileMetadata.parents = [folderId];
  }

  // RFC 2046 compliant multipart body starting with --boundary
  const multipartBody =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    JSON.stringify(fileMetadata) +
    `\r\n--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    packageJsonText +
    `\r\n--${boundary}--`;

  const uploadRes = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,webContentLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );

  if (uploadRes.status === 401) {
    cachedAccessToken = null;
    throw new Error('Your Google authorization has expired. Please sign in with Google again.');
  }

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error('[Google Drive] File upload failed:', uploadRes.status, errText);
    throw new Error(`Google Drive upload failed (${uploadRes.status}): ${errText}`);
  }

  const uploadData = await uploadRes.json();

  // 2. If SRT subtitles provided, upload SRT file as well
  if (payload.srtContent) {
    onProgress?.('Uploading SRT subtitle track to Drive...', 75);
    const srtBoundary = 'ForgeStudioSrtBoundary' + Date.now();
    const srtMetadata: Record<string, any> = {
      name: `${baseFileName}-Captions.srt`,
      mimeType: 'text/plain',
      description: `SRT Subtitles for ${payload.title}`,
    };
    if (folderId) {
      srtMetadata.parents = [folderId];
    }

    const srtMultipart =
      `--${srtBoundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      JSON.stringify(srtMetadata) +
      `\r\n--${srtBoundary}\r\n` +
      'Content-Type: text/plain; charset=UTF-8\r\n\r\n' +
      payload.srtContent +
      `\r\n--${srtBoundary}--`;

    try {
      await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${srtBoundary}`,
          },
          body: srtMultipart,
        }
      );
    } catch (e) {
      console.warn('[Google Drive] SRT upload failed, continuing with primary export:', e);
    }
  }

  onProgress?.('Finalizing Google Drive export...', 100);

  return {
    fileId: uploadData.id,
    fileName: uploadData.name,
    webViewLink: uploadData.webViewLink || `https://drive.google.com/file/d/${uploadData.id}/view`,
    folderId,
  };
}
