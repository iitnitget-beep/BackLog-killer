/**
 * GitHub Device Flow (OAuth). The phone shows a short code, the user types it on
 * any device, and the app polls for the token - no client secret is embedded in
 * the APK, which is the whole point of device flow for public clients.
 *
 * Only the token request is implemented here; the UI layer opens the
 * verification URL. Token is handed straight to the Keystore port.
 */
import type { Platform } from '../platform/types';

export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceFlowPoll {
  status: 'pending' | 'slow_down' | 'authorized' | 'denied' | 'expired' | 'error';
  token?: string;
  scope?: string;
  message?: string;
}

export class GitHubDeviceFlow {
  constructor(
    private readonly platform: Platform,
    private readonly clientId: string,
    private readonly endpoint: string = 'https://github.com/login/device/code',
  ) {}

  async start(scopes = 'repo workflow read:user'): Promise<DeviceFlowStart> {
    const response = await this.platform.http({
      url: this.endpoint,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: `client_id=${encodeURIComponent(this.clientId)}&scope=${encodeURIComponent(scopes)}`,
      timeoutMs: 30_000,
    });
    if (response.status >= 400) {
      throw new Error(`device flow start failed: ${response.status} ${response.body.slice(0, 200)}`);
    }
    const data = JSON.parse(response.body) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };
    return {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      interval: data.interval ?? 5,
    };
  }

  /** One poll. The caller owns the wait loop so the UI can stay responsive. */
  async poll(deviceCode: string): Promise<DeviceFlowPoll> {
    const tokenEndpoint = this.endpoint.replace('/device/code', '/access_token');
    const response = await this.platform.http({
      url: tokenEndpoint,
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: `client_id=${encodeURIComponent(this.clientId)}&device_code=${encodeURIComponent(deviceCode)}&grant_type=urn:ietf:params:oauth:grant-type:device_code`,
      timeoutMs: 30_000,
    });
    const data = JSON.parse(response.body) as {
      access_token?: string;
      scope?: string;
      error?: string;
      error_description?: string;
    };
    if (data.access_token) return { status: 'authorized', token: data.access_token, scope: data.scope };
    switch (data.error) {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return { status: 'slow_down' };
      case 'expired_token':
        return { status: 'expired' };
      case 'access_denied':
        return { status: 'denied' };
      default:
        return { status: 'error', message: data.error_description ?? data.error ?? 'unknown error' };
    }
  }
}
