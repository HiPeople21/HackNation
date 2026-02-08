export const CapabilityTier = Object.freeze({
  ORACLE: 1,
  NAVIGATOR: 2,
  ACTOR: 3,
});

export class CapabilityManager {
  constructor() {
    this.tierNames = new Map([
      [CapabilityTier.ORACLE, "Oracle"],
      [CapabilityTier.NAVIGATOR, "Navigator"],
      [CapabilityTier.ACTOR, "Actor"],
    ]);
  }

  getTierName(tier) {
    return this.tierNames.get(tier) || "Unknown";
  }

  canUseTool(requestedTier, toolTier) {
    return requestedTier >= toolTier;
  }

  assertTierAllowed(requestedTier, toolTier) {
    if (!this.canUseTool(requestedTier, toolTier)) {
      const requestedName = this.getTierName(requestedTier);
      const toolName = this.getTierName(toolTier);
      throw new Error(
        `Capability tier ${requestedName} cannot access ${toolName} tools.`
      );
    }
  }
}
