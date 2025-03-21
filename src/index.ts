import { sync as commandExists } from "command-exists";
import createDebug from "debug";
import { existsSync as exists, readFileSync as readFile, readdirSync as readdir } from "fs";
import isValidDomain from "is-valid-domain";
import rimraf from "rimraf";
import installCertificateAuthority, { ensureCACertReadable, uninstall } from "./certificate-authority";
import { generateDomainCertificate, revokeDomainCertificate } from "./certificates";
import {
    configDir,
    domainsDir,
    getStableDomainPath,
    isLinux,
    isMac,
    isWindows,
    pathForDomain,
    rootCACertPath,
    rootCAKeyPath,
} from "./constants";
import currentPlatform from "./platforms";
import UI, { UserInterface } from "./user-interface";
import { openssl, parseOpenSSLExpiryData } from './utils';

const debug = createDebug("devcert");

export interface Options /* extends Partial<ICaBufferOpts & ICaPathOpts>  */ {
    /** Return the CA certificate data? */
    getCaBuffer?: boolean;
    /** Return the path to the CA certificate? */
    getCaPath?: boolean;
    /** If `certutil` is not installed already (for updating nss databases; e.g. firefox), do not attempt to install it */
    skipCertutilInstall?: boolean;
    /** Do not update your systems host file with the domain name of the certificate */
    skipHostsFile?: boolean;
    /** User interface hooks */
    ui?: UserInterface;
}

interface ICaBuffer {
    ca: Buffer;
}
interface ICaPath {
    caPath: string;
}
interface IDomainData {
    key: Buffer;
    cert: Buffer;
}
type IReturnCa<O extends Options> = O["getCaBuffer"] extends true ? ICaBuffer : false;
type IReturnCaPath<O extends Options> = O["getCaPath"] extends true ? ICaPath : false;
type IReturnData<O extends Options = {}> = IDomainData & IReturnCa<O> & IReturnCaPath<O>;

/**
 * Request an SSL certificate for the given app name signed by the devcert root
 * certificate authority. If devcert has previously generated a certificate for
 * that app name on this machine, it will reuse that certificate.
 *
 * If this is the first time devcert is being run on this machine, it will
 * generate and attempt to install a root certificate authority.
 *
 * Returns a promise that resolves with { key, cert }, where `key` and `cert`
 * are Buffers with the contents of the certificate private key and certificate
 * file, respectively
 *
 * If `options.getCaBuffer` is true, return value will include the ca certificate data
 * as { ca: Buffer }
 *
 * If `options.getCaPath` is true, return value will include the ca certificate path
 * as { caPath: string }
 */
export async function certificateFor<O extends Options>(
    requestedDomains: string | string[],
    options: O = {} as O
): Promise<IReturnData<O>> {
    const domains = Array.isArray(requestedDomains) ? requestedDomains : [requestedDomains];
    domains.forEach((domain) => {
        if (
            domain !== "localhost" &&
            !isValidDomain(domain, { subdomain: true, wildcard: false, allowUnicode: true, topLevel: false })
        ) {
            throw new Error(`"${domain}" is not a valid domain name.`);
        }
    });

    const domainPath = getStableDomainPath(domains);
    debug(
        `Certificate requested for ${domains}. Skipping certutil install: ${Boolean(
            options.skipCertutilInstall
        )}. Skipping hosts file: ${Boolean(options.skipHostsFile)}`
    );

    if (options.ui) {
        Object.assign(UI, options.ui);
    }

    if (!isMac && !isLinux && !isWindows) {
        throw new Error(`Platform not supported: "${process.platform}"`);
    }

    if (!commandExists("openssl")) {
        throw new Error(
            "OpenSSL not found: OpenSSL is required to generate SSL certificates - make sure it is installed and available in your PATH"
        );
    }

    let domainKeyPath = pathForDomain(domainPath, `private-key.key`);
    let domainCertPath = pathForDomain(domainPath, `certificate.crt`);

    if (!exists(rootCAKeyPath)) {
        debug("Root CA is not installed yet, so it must be our first run. Installing root CA ...");
        await installCertificateAuthority(options);
    } else if (options.getCaBuffer || options.getCaPath) {
        debug(
            "Root CA is not readable, but it probably is because an earlier version of devcert locked it. Trying to fix..."
        );
        await ensureCACertReadable(options);
    }

    if (!exists(pathForDomain(domainPath, `certificate.crt`))) {
        debug(
            `Can't find certificate file for ${domains}, so it must be the first request for ${domains}. Generating and caching ...`
        );
        await generateDomainCertificate(domains);
    }

    if (!options.skipHostsFile) {
        domains.forEach(async (domain) => {
            await currentPlatform.addDomainToHostFileIfMissing(domain);
        });
    }

    debug(`Returning domain certificate`);

    const ret = {
        key: readFile(domainKeyPath),
        cert: readFile(domainCertPath),
    } as IReturnData<O>;
    if (options.getCaBuffer) (ret as unknown as ICaBuffer).ca = readFile(rootCACertPath);
    if (options.getCaPath) (ret as unknown as ICaPath).caPath = rootCACertPath;

    return ret;
}

export function hasCertificateFor(requestedDomains: string | string[]) {
    const domains = Array.isArray(requestedDomains) ? requestedDomains : [requestedDomains];
    const domainPath = getStableDomainPath(domains);
    return exists(pathForDomain(domainPath, `certificate.crt`));
}

export function configuredDomains() {
    return readdir(domainsDir);
}

export function location(): string {
    return configDir;
}

export async function removeDomain(requestedDomains: string | string[]) {
    const domains = Array.isArray(requestedDomains) ? requestedDomains : [requestedDomains];
    await revokeDomainCertificate(domains);

    const domainPath = getStableDomainPath(domains);
    return rimraf.sync(pathForDomain(domainPath));
}

export function removeAll(): void {
    uninstall();
}

export function caExpiryInDays(): number {
    try {
        const caExpiryData = openssl(['x509', '-in', rootCACertPath, '-noout', '-enddate' ]).toString().trim();
        return parseOpenSSLExpiryData(caExpiryData);
    } catch {
        return -1;
    }
}

export function certificateExpiryInDays(domain: string): number {
    const domainPath = getStableDomainPath([domain]);
    let domainCertPath = pathForDomain(domainPath, 'certificate.crt');

    try {
        const certExpiryData = openssl(['x509', '-in', domainCertPath, '-noout', '-enddate' ]).toString().trim();
        return parseOpenSSLExpiryData(certExpiryData);
    } catch {
        return -1;
    }
}
