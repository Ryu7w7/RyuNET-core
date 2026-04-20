import crypto from 'crypto';

export class EaCloud {
  // Configured protocol signatures based on client versions
  private static readonly SIGNATURE_201509180 = {
    req: 'fAwHp6G2FLPHN_ZGBhREJG5flt3hNu',
    res: 'NH_P-urkCV9npxR90kaAR7YnqDTRL-',
  };

  private static readonly SIGNATURE_2017012700 = {
    req: 'zfrKY435urm4VaZeV_h6rTH43Gpp_sfg',
    res: 'ZnP5cdGixAtac24ZtaTa2ABm9RkWaNes',
  };

  private static readonly SIGNATURE_2020090800 = {
    req: 'd4BK3JFREkH5WuyTVEJQ2jbS9h2-df4D',
    res: 'tGhCtgLuTjV7cZ2phWuCpQ8iwSypVn4W',
  };

  public static requestKeyFromProtocolVersion(protocolVersion: string): string {
    return EaCloud.keyFromProtocolVersion(protocolVersion, 'req');
  }

  public static responseKeyFromProtocolVersion(protocolVersion: string): string {
    return EaCloud.keyFromProtocolVersion(protocolVersion, 'res');
  }

  private static keyFromProtocolVersion(protocolVersion: string, type: 'req' | 'res'): string {
    switch (protocolVersion) {
      case 'P2D:2015091800':
        return EaCloud.SIGNATURE_201509180[type];
      case '2017012700':
        return EaCloud.SIGNATURE_2017012700[type];
      case '2020090800':
        return EaCloud.SIGNATURE_2020090800[type];
      default:
        return '';
    }
  }

  public static convertValidBase64(base64Str: string): string {
    return base64Str.replace(/-/g, '+').replace(/_/g, '/');
  }

  public static buildTimeBuffer(timeMin: number): Buffer {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(timeMin), 0);
    return buf;
  }

  // Generate SHA-256 signature for server response
  public static generateResponseSignature(
    responseBody: Buffer,
    timeMin: number,
    responseKey: string
  ): Buffer {
    const timeBuf = EaCloud.buildTimeBuffer(timeMin);
    const hash = crypto.createHash('sha256');
    hash.update(responseBody);
    hash.update(timeBuf);
    hash.update(Buffer.from(responseKey, 'utf-8'));
    return hash.digest(); // Returns binary buffer of size 32
  }

  // Validate the client signature
  // Returns the timestamp (in minutes) that matched, or -1 if none matched.
  public static validateRequestSignature(
    requestBody: Buffer,
    requestSignatureHex: string,
    protocolVersion: string
  ): number {
    const reqKey = EaCloud.requestKeyFromProtocolVersion(protocolVersion);
    if (!reqKey) return -1;

    const currentTimeMin = Math.floor(Date.now() / 1000 / 60);

    // Give a margin of +/- 1 minute due to time drifting
    for (const offset of [0, -1, 1]) {
      const timeToTest = currentTimeMin + offset;
      const timeBuf = EaCloud.buildTimeBuffer(timeToTest);

      const hash = crypto.createHash('sha256');
      hash.update(requestBody);
      hash.update(timeBuf);
      hash.update(Buffer.from(reqKey, 'utf-8'));
      
      if (hash.digest('hex') === requestSignatureHex) {
        return timeToTest;
      }
    }

    return -1;
  }
}
