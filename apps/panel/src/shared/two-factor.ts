export interface TwoFactorStatus { available: boolean; enabled: boolean; pending: boolean; recoveryCodesRemaining: number }
export interface TwoFactorSetup { secret: string; uri: string; expiresAt: string }
