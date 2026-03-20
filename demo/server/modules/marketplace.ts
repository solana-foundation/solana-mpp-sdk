import type { Express } from 'express';
import type { KeyPairSigner } from '@solana/kit';
import { Mppx, solana } from '../sdk.js';
import { toWebRequest, logPayment } from '../utils.js';
import { USDC_MINT } from '../constants.js';

const PRODUCTS: Record<
    string,
    { name: string; price: number; seller: string; description: string }
> = {
    'sol-hoodie': {
        name: 'Solana Hoodie',
        price: 2_000_000, // 2 USDC
        seller: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        description: 'Premium Solana-branded hoodie',
    },
    'validator-mug': {
        name: 'Validator Mug',
        price: 1_000_000, // 1 USDC
        seller: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        description: 'Ceramic mug for node operators',
    },
    'nft-sticker-pack': {
        name: 'NFT Sticker Pack',
        price: 500_000, // 0.50 USDC
        seller: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
        description: 'Holographic sticker collection',
    },
};

// Platform fee: 5% of product price
const PLATFORM_FEE_BPS = 500; // 5% in basis points
// Referral commission: 2%
const REFERRAL_FEE_BPS = 200;

export function registerMarketplace(
    app: Express,
    platformAddress: string,
    network: string,
    secretKey: string,
    feePayerSigner: KeyPairSigner,
) {
    // List products
    app.get('/api/v1/marketplace/products', (_req, res) => {
        const list = Object.entries(PRODUCTS).map(([id, p]) => ({
            id,
            name: p.name,
            description: p.description,
            price: `${(p.price / 1_000_000).toFixed(2)} USDC`,
            priceRaw: String(p.price),
        }));
        res.json(list);
    });

    // Purchase with splits
    app.get('/api/v1/marketplace/buy/:productId', async (req, res) => {
        const product = PRODUCTS[req.params.productId];
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }

        const referrer = req.query.referrer as string | undefined;

        // Compute splits
        const platformFee = Math.floor((product.price * PLATFORM_FEE_BPS) / 10_000);
        const referralFee = referrer ? Math.floor((product.price * REFERRAL_FEE_BPS) / 10_000) : 0;
        const totalAmount = product.price + platformFee + referralFee;

        const splits: Array<{ recipient: string; amount: string; memo?: string }> = [
            { recipient: platformAddress, amount: String(platformFee), memo: 'platform fee (5%)' },
        ];

        if (referrer) {
            splits.push({ recipient: referrer, amount: String(referralFee), memo: 'referral (2%)' });
        }

        const mppx = Mppx.create({
            secretKey,
            methods: [
                solana.charge({
                    recipient: product.seller,
                    network,
                    signer: feePayerSigner,
                    currency: USDC_MINT,
                    decimals: 6,
                    splits,
                }),
            ],
        });

        const result = await mppx.charge({
            amount: String(totalAmount),
            currency: 'USDC',
            description: `Purchase: ${product.name}`,
        })(toWebRequest(req));

        if (result.status === 402) {
            const challenge = result.challenge as Response;
            res.writeHead(challenge.status, Object.fromEntries(challenge.headers));
            res.end(await challenge.text());
            return;
        }

        const response = result.withReceipt(
            Response.json({
                product: product.name,
                breakdown: {
                    seller: `${(product.price / 1_000_000).toFixed(2)} USDC`,
                    platformFee: `${(platformFee / 1_000_000).toFixed(2)} USDC`,
                    ...(referrer ? { referralFee: `${(referralFee / 1_000_000).toFixed(2)} USDC` } : {}),
                    total: `${(totalAmount / 1_000_000).toFixed(2)} USDC`,
                },
                status: 'purchased',
            }),
        ) as Response;
        logPayment(req.path, response);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(await response.text());
    });
}
