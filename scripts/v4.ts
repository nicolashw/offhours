/**
 * OffHours — Uniswap V4 read layer.
 *
 * V4 pools are not contracts. They live as entries in the singleton
 * PoolManager's storage, addressed by poolId = keccak256(abi.encode(PoolKey)),
 * and read through `extsload(bytes32)`. StateLibrary's layout:
 *
 *   stateSlot = keccak256(abi.encodePacked(poolId, uint256(POOLS_SLOT=6)))
 *   stateSlot + 0 -> Slot0   : sqrtPriceX96 (160) | tick (24) | protocolFee (24) | lpFee (24)
 *   stateSlot + 3 -> liquidity (uint128)
 *
 * Because hooks and tickSpacing cannot be guessed, poolIds come from Initialize
 * events (see discover.ts) rather than from a fee-tier grid the way V3 does.
 */

import { keccak256, encodeAbiParameters, encodePacked, encodeFunctionData, type Address, type Hex } from "viem";

export const POOLS_SLOT = 6n;
export const LIQUIDITY_OFFSET = 3n;

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };

export function poolIdOf(k: PoolKey): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
  ));
}

export function stateSlotOf(poolId: Hex): Hex {
  return keccak256(encodePacked(["bytes32", "uint256"], [poolId, POOLS_SLOT]));
}

export function addSlot(slot: Hex, offset: bigint): Hex {
  return `0x${((BigInt(slot) + offset) & ((1n << 256n) - 1n)).toString(16).padStart(64, "0")}` as Hex;
}

export const extsloadAbi = [
  { type: "function", name: "extsload", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32" }] },
] as const;

export function extsloadCalldata(slot: Hex): Hex {
  return encodeFunctionData({ abi: extsloadAbi, functionName: "extsload", args: [slot] });
}

/** Unpack a Slot0 word. tick is a signed 24-bit field and must be sign-extended. */
export function decodeSlot0(word: Hex) {
  const v = BigInt(word);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & ((1n << 24n) - 1n));
  if (tick >= 1 << 23) tick -= 1 << 24;
  const protocolFee = Number((v >> 184n) & ((1n << 24n) - 1n));
  const lpFee = Number((v >> 208n) & ((1n << 24n) - 1n));
  return { sqrtPriceX96, tick, protocolFee, lpFee };
}

export function decodeLiquidity(word: Hex): bigint {
  return BigInt(word) & ((1n << 128n) - 1n);
}

/** V4 encodes "this pool asks its hook for the fee on every swap" as this flag. */
export const DYNAMIC_FEE_FLAG = 0x800000;
export const isDynamicFee = (fee: number) => fee === DYNAMIC_FEE_FLAG;
