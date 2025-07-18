import { Connection, PublicKey, Keypair, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { loadConfigFromCookies, WalletType } from '../Utils'; // Assuming this is the same import as in existing code

// Constants
const MAX_BUNDLES_PER_SECOND = 2;

// Rate limiting state
const rateLimitState = {
  count: 0,
  lastReset: Date.now(),
  maxBundlesPerSecond: MAX_BUNDLES_PER_SECOND
};

// Interfaces
interface WalletMoonSell {
  address: string;
  privateKey: string;
}

interface TokenConfig {
  tokenAddress: string;
  sellPercent: number;
}

export interface MoonSellBundle {
  transactions: string[]; // Base58 encoded transaction data
}

// Define interface for bundle result
interface BundleResult {
  jsonrpc: string;
  id: number;
  result?: string;
  error?: {
    code: number;
    message: string;
  };
}

/**
 * Check rate limit and wait if necessary
 */
const checkRateLimit = async (): Promise<void> => {
  const now = Date.now();

  if (now - rateLimitState.lastReset >= 1000) {
    rateLimitState.count = 0;
    rateLimitState.lastReset = now;
  }

  if (rateLimitState.count >= rateLimitState.maxBundlesPerSecond) {
    const waitTime = 1000 - (now - rateLimitState.lastReset);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    rateLimitState.count = 0;
    rateLimitState.lastReset = Date.now();
  }

  rateLimitState.count++;
};

/**
 * Send bundle to Jito block engine through our backend proxy
 */
const sendBundle = async (encodedBundle: string[]): Promise<BundleResult> => {
  try {
    const baseUrl = (window as any).tradingServerUrl?.replace(/\/+$/, '') || '';

    // Send to our backend proxy instead of directly to Jito
    const response = await fetch(`${baseUrl}/api/transactions/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transactions: encodedBundle
      }),
    });

    const data = await response.json();
    return data.result;
  } catch (error) {
    console.error('Error sending bundle:', error);
    throw error;
  }
};

/**
 * Get partially prepared moon sell transactions from backend.
 * This function checks whether the backend returned bundles.
 */
const getPartiallyPreparedTransactions = async (
  walletAddresses: string[],
  tokenConfig: TokenConfig
): Promise<MoonSellBundle[]> => {
  try {
    const baseUrl = (window as any).tradingServerUrl?.replace(/\/+$/, '') || '';

    const config = loadConfigFromCookies();
    // Get fee in SOL (string) with default if not found
    const feeInSol = config?.transactionFee || '0.005';
    const feeInLamports = Math.floor(parseFloat(feeInSol) * 1_000_000_000);
    const response = await fetch(`${baseUrl}/api/tokens/sell`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': config?.apiKey || '' 
      },
      body: JSON.stringify({
        walletAddresses,
        tokenAddress: tokenConfig.tokenAddress,
        protocol: "moonshot",
        percentage: tokenConfig.sellPercent,
        jitoTipLamports: feeInLamports  // Now a number in lamports
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || 'Failed to get partially prepared transactions');
    }

    // If backend returned bundles, ensure each bundle is an object with a transactions property.
    if (data.bundles && Array.isArray(data.bundles)) {
      return data.bundles.map((bundle: any) =>
        Array.isArray(bundle) ? { transactions: bundle } : bundle
      );
    } else if (data.transactions && Array.isArray(data.transactions)) {
      return [{ transactions: data.transactions }];
    } else if (Array.isArray(data)) {
      return [{ transactions: data }];
    } else {
      throw new Error('No transactions returned from backend');
    }
  } catch (error) {
    console.error('Error getting partially prepared transactions:', error);
    throw error;
  }
};

/**
 * Complete transaction signing for a single bundle.
 */
const completeBundleSigning = (
  bundle: MoonSellBundle,
  walletKeypairs: Keypair[]
): MoonSellBundle => {
  const signedTransactions = bundle.transactions.map(txBase58 => {
    // Deserialize transaction
    const txBuffer = bs58.decode(txBase58);
    const transaction = VersionedTransaction.deserialize(txBuffer);

    // Determine required signers from staticAccountKeys
    const signers: Keypair[] = [];
    for (const accountKey of transaction.message.staticAccountKeys) {
      const pubkeyStr = accountKey.toBase58();
      const matchingKeypair = walletKeypairs.find(
        kp => kp.publicKey.toBase58() === pubkeyStr
      );
      if (matchingKeypair && !signers.includes(matchingKeypair)) {
        signers.push(matchingKeypair);
      }
    }

    // Sign the transaction
    transaction.sign(signers);

    // Serialize and encode the fully signed transaction
    return bs58.encode(transaction.serialize());
  });
  return { transactions: signedTransactions };
};

/**
 * Execute moon sell operation.
 */
export const executeMoonSell = async (
  wallets: WalletMoonSell[],
  tokenConfig: TokenConfig
): Promise<{ success: boolean; result?: any; error?: string }> => {
  try {
    console.log(`Preparing to moon sell ${tokenConfig.sellPercent}% of ${tokenConfig.tokenAddress} using ${wallets.length} wallets`);

    // Extract wallet addresses
    const walletAddresses = wallets.map(wallet => wallet.address);

    // Step 1: Get partially prepared transactions (bundles) from backend
    const partiallyPreparedBundles = await getPartiallyPreparedTransactions(walletAddresses, tokenConfig);
    console.log(`Received ${partiallyPreparedBundles.length} bundles from backend`);

    // Step 2: Create keypairs from private keys
    const walletKeypairs = wallets.map(wallet =>
      Keypair.fromSecretKey(bs58.decode(wallet.privateKey))
    );

    // Step 3: Complete transaction signing for each bundle
    const signedBundles = partiallyPreparedBundles.map(bundle =>
      completeBundleSigning(bundle, walletKeypairs)
    );
    console.log(`Completed signing for ${signedBundles.length} bundles`);

    // Step 4: Send each bundle with rate limiting and delay between bundles
    let results: BundleResult[] = [];
    for (let i = 0; i < signedBundles.length; i++) {
      const bundle = signedBundles[i];
      console.log(`Sending bundle ${i + 1}/${signedBundles.length} with ${bundle.transactions.length} transactions`);

      await checkRateLimit();
      const result = await sendBundle(bundle.transactions);
      results.push(result);

      // Add delay between bundles (except after the last one)
      if (i < signedBundles.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
      }
    }

    return {
      success: true,
      result: results
    };
  } catch (error) {
    console.error('Moon sell error:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Validate moon sell inputs.
 */
export const validateMoonSellInputs = (
  wallets: WalletMoonSell[],
  tokenConfig: TokenConfig,
  tokenBalances: Map<string, number>
): { valid: boolean; error?: string } => {
  // Check if token config is valid
  if (!tokenConfig.tokenAddress) {
    return { valid: false, error: 'Invalid token address' };
  }

  if (isNaN(tokenConfig.sellPercent) || tokenConfig.sellPercent <= 0 || tokenConfig.sellPercent > 100) {
    return { valid: false, error: 'Invalid sell percentage (must be between 1-100)' };
  }

  // Check if wallets are valid
  if (!wallets.length) {
    return { valid: false, error: 'No wallets provided' };
  }

  // Check if at least one wallet has token balance
  let hasTokens = false;
  for (const wallet of wallets) {
    if (!wallet.address || !wallet.privateKey) {
      return { valid: false, error: 'Invalid wallet data' };
    }

    const balance = tokenBalances.get(wallet.address) || 0;
    if (balance > 0) {
      hasTokens = true;
      break;
    }
  }

  if (!hasTokens) {
    return { valid: false, error: 'No token balance found in any wallet' };
  }

  return { valid: true };
};
