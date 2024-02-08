import {
    Provider as L1Provider,
    JsonRpcProvider as L1JsonRpcProvider,
    Interface,
    Contract,
} from "ethers";
import { Provider as L2Provider } from "zksync-ethers";
import {
    BatchMetadata,
    CommitBatchInfo,
    StorageProof,
    StoredBatchInfo,
} from "./types";
import { inspect } from "util";

/** Interface of the Diamond Contract */
const ZKSYNC_DIAMOND_INTERFACE = new Interface([
    `function commitBatches(
    (uint64,bytes32,uint64,uint256,bytes32,bytes32,uint256,bytes32) lastCommittedBatchData,
    (uint64,uint64,uint64,bytes32,uint256,bytes32,bytes32,bytes32,bytes,bytes)[] newBatchesData
  )`,
    `function l2LogsRootHash(uint256 _batchNumber) external view returns (bytes32)`,
    `event BlockCommit(uint256 indexed batchNumber, bytes32 indexed batchHash, bytes32 indexed commitment)`,
    `function storedBatchHash(uint256) public view returns (bytes32)`,
]);

/** Omits batch hash from stored batch info */
const formatStoredBatchInfo = (batchInfo: StoredBatchInfo): BatchMetadata => {
    const { batchHash, ...metadata } = batchInfo;
    return metadata;
};

/** Storage proof provider for zkSync */
export class StorageProofProvider {
    readonly diamondContract: Contract;

    constructor(
        readonly l1Provider: L1Provider,
        readonly l2Provider: L2Provider,
        readonly diamondAddress: string
    ) {
        this.diamondContract = new Contract(
            diamondAddress,
            ZKSYNC_DIAMOND_INTERFACE,
            l1Provider
        );
    }

    /** Returns logs root hash stored in L1 contract */
    private async getL2LogsRootHash(batchNumber: number): Promise<string> {
        const l2RootsHash = await this.diamondContract.l2LogsRootHash(
            batchNumber
        );
        return String(l2RootsHash);
    }

    /** Returns ZkSync proof response */
    private async getL2Proof(
        account: string,
        storageKeys: Array<string>,
        batchNumber: number
    ): Promise<Array<StorageProof>> {
        try {
            // Account proofs don't exist in zkSync, so we're only using storage proofs
            const { storageProof } = await this.l2Provider.send(
                "zks_getProof",
                [account, storageKeys, batchNumber]
            );
            return { ...storageProof, account };
        } catch (e) {
            throw new Error(`Failed to get proof from L2 provider, ${e}`);
        }
    }

    /** Parses the transaction where batch is committed and returns commit info */
    private async parseCommitTransaction(
        txHash: string,
        batchNumber: number
    ): Promise<{ commitBatchInfo: CommitBatchInfo; commitment: string }> {
        const transactionData = await this.l1Provider.getTransaction(txHash);
        const [, newBatch] = ZKSYNC_DIAMOND_INTERFACE.decodeFunctionData(
            "commitBatches",
            transactionData!.data
        );

        // Find the batch with matching number
        const batch = newBatch.find((batch: any) => {
            return batch[0] === BigInt(batchNumber);
        });
        if (batch == undefined) {
            throw new Error(`Batch ${batchNumber} not found in calldata`);
        }

        const commitBatchInfo: CommitBatchInfo = {
            batchNumber: batch[0],
            timestamp: batch[1],
            indexRepeatedStorageChanges: batch[2],
            newStateRoot: batch[3],
            numberOfLayer1Txs: batch[4],
            priorityOperationsHash: batch[5],
            bootloaderHeapInitialContentsHash: batch[6],
            eventsQueueStateHash: batch[7],
            systemLogs: batch[8],
            totalL2ToL1Pubdata: batch[9],
        };

        const receipt = await this.l1Provider.getTransactionReceipt(txHash);
        if (receipt == undefined) {
            throw new Error(`Receipt for commit tx ${txHash} not found`);
        }

        // Parse event logs of the transaction to find commitment
        const blockCommitFilter = ZKSYNC_DIAMOND_INTERFACE.encodeFilterTopics(
            "BlockCommit",
            [batchNumber]
        );
        const commitLog = receipt.logs.find(
            (log) =>
                log.address === this.diamondAddress &&
                blockCommitFilter.every((topic, i) => topic === log.topics[i])
        );
        if (commitLog == undefined) {
            throw new Error(`Commit log for batch ${batchNumber} not found`);
        }
        const { commitment } = ZKSYNC_DIAMOND_INTERFACE.decodeEventLog(
            "BlockCommit",
            commitLog.data,
            commitLog.topics
        );

        return { commitBatchInfo, commitment };
    }

    /**
     * Returns the stored batch info for the given batch number.
     * Returns null if the batch is not stored.
     * @param batchNumber
     */
    async getStoredBatchInfo(batchNumber: number): Promise<StoredBatchInfo> {
        const { commitTxHash, proveTxHash } =
            await this.l2Provider.getL1BatchDetails(batchNumber);

        // If batch is not committed or proved, return null
        if (commitTxHash == undefined) {
            throw new Error(`Batch ${batchNumber} is not committed`);
        } else if (proveTxHash == undefined) {
            throw new Error(`Batch ${batchNumber} is not proved`);
        }

        // Parse commit calldata from commit transaction
        const { commitBatchInfo, commitment } =
            await this.parseCommitTransaction(commitTxHash, batchNumber);
        const l2LogsTreeRoot = await this.getL2LogsRootHash(batchNumber);

        const storedBatchInfo: StoredBatchInfo = {
            batchNumber: commitBatchInfo.batchNumber,
            batchHash: commitBatchInfo.newStateRoot,
            indexRepeatedStorageChanges:
                commitBatchInfo.indexRepeatedStorageChanges,
            numberOfLayer1Txs: commitBatchInfo.numberOfLayer1Txs,
            priorityOperationsHash: commitBatchInfo.priorityOperationsHash,
            l2LogsTreeRoot,
            timestamp: commitBatchInfo.timestamp,
            commitment,
        };
        return storedBatchInfo;
    }

    /**
     * Gets the proof and related data for the given batch number, address and storage keys.
     * @param address
     * @param storageKeys
     * @param batchNumber
     * @returns
     */
    async getProofs(
        address: string,
        storageKeys: Array<string>,
        batchNumber?: number
    ): Promise<{
        metadata: BatchMetadata;
        proofs: Array<StorageProof>;
    }> {
        // If batch number is not provided, get the latest batch number
        batchNumber =
            batchNumber ?? (await this.l2Provider.getL1BatchNumber()) - 2000;

        const proofs = await this.getL2Proof(address, storageKeys, batchNumber);

        const metadata = await this.getStoredBatchInfo(batchNumber).then(
            formatStoredBatchInfo
        );

        return { metadata, proofs };
    }

    /**
     * Gets a single proof
     * @param address
     * @param storageKey
     * @param batchNumber
     * @returns
     */
    async getProof(
        address: string,
        storageKey: string,
        batchNumber?: number
    ): Promise<{
        metadata: BatchMetadata;
        proof: StorageProof;
    }> {
        const { metadata, proofs } = await this.getProofs(
            address,
            [storageKey],
            batchNumber
        );
        return { metadata, proof: proofs[0] };
    }
}

export const MainnetStorageProofProvider = new StorageProofProvider(
    new L1JsonRpcProvider("https://eth.llamarpc.com"),
    new L2Provider("https://mainnet.era.zksync.io"),
    "0x32400084C286CF3E17e7B677ea9583e60a000324"
);

export const SepoliaStorageProofProvider = new StorageProofProvider(
    new L1JsonRpcProvider("https://ethereum-sepolia.publicnode.com"),
    new L2Provider("https://sepolia.era.zksync.dev"),
    "0x9A6DE0f62Aa270A8bCB1e2610078650D539B1Ef9"
);

async function main() {
    const batchNumber = process.argv[2] ? parseInt(process.argv[2]) : undefined;

    const proof = await SepoliaStorageProofProvider.getProof(
        "0x0000000000000000000000000000000000008003",
        "0x8b65c0cf1012ea9f393197eb24619fd814379b298b238285649e14f936a5eb12",
        batchNumber
    );
    console.log(inspect(proof, { colors: true, depth: null }));
}

main();
