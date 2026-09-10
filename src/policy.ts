/** A prohibited command or missing required execution policy attestation. */
export class SdlcPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SdlcPolicyError";
  }
}
