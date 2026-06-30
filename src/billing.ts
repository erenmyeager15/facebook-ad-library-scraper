export interface PushDataChargeResult {
    chargedCount: number;
    eventChargeLimitReached?: boolean;
}

export function wasPushedRecordSaved(result: PushDataChargeResult): boolean {
    return result.chargedCount > 0 || result.eventChargeLimitReached !== true;
}
