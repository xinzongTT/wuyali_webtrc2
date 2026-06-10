export type RtcConfigSettings = {
  stunUrls: string;
  turnUrls: string;
  turnUsername: string;
  turnCredential: string;
  forceRelay: boolean;
};

export type IceServerConfig = {
  urls: string | string[];
  username?: string;
  credential?: string;
};

export type RtcConfigResponse = {
  iceTransportPolicy: "all" | "relay";
  iceServers: IceServerConfig[];
};

export type CandidatePairInput = {
  localCandidateType?: string | null;
  remoteCandidateType?: string | null;
  protocol?: string | null;
  currentRoundTripTime?: number | null;
  availableOutgoingBitrate?: number | null;
};

export function buildRtcConfig(settings: RtcConfigSettings): RtcConfigResponse {
  const iceServers: IceServerConfig[] = [];
  const stunUrls = splitUrls(settings.stunUrls);
  const turnUrls = splitUrls(settings.turnUrls);

  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls });
  }

  if (turnUrls.length > 0) {
    iceServers.push({
      urls: turnUrls,
      username: settings.turnUsername,
      credential: settings.turnCredential
    });
  }

  return {
    iceTransportPolicy: settings.forceRelay ? "relay" : "all",
    iceServers
  };
}

export function summarizeCandidatePair(input: CandidatePairInput) {
  return {
    path: input.localCandidateType === "relay" || input.remoteCandidateType === "relay" ? "TURN" : "DIRECT",
    localCandidateType: input.localCandidateType ?? null,
    remoteCandidateType: input.remoteCandidateType ?? null,
    protocol: input.protocol ?? null,
    rttMs: input.currentRoundTripTime == null ? null : Math.round(input.currentRoundTripTime * 1000),
    availableOutgoingKbps: input.availableOutgoingBitrate == null ? null : Math.round(input.availableOutgoingBitrate / 1024)
  };
}

function splitUrls(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
