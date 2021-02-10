import { expect } from '../../../../setup'

/* External Imports */
import { ethers } from 'hardhat'
import { Signer, ContractFactory, Contract, BigNumber } from 'ethers'
import { smockit, MockContract, smoddit, ModifiableContract } from '@eth-optimism/smock'

/* Internal Imports */
import {
  NON_ZERO_ADDRESS, ZERO_ADDRESS
} from '../../../../helpers'

const HARDCODED_GASLIMIT = 420069
const decimals = 1

const INVALID_MESSENGER = 'OVM_XCHAIN: messenger contract unauthenticated'
const INVALID_X_DOMAIN_MSG_SENDER = 'OVM_XCHAIN: wrong sender of cross-domain message'
const MOCK_L1_ERC20_ADDRESS: string = '0x1234123412341234123412341234123412341234'

describe.only('OVM_L2ERC20Gateway', () => {
  let alice: Signer
  let bob: Signer
  let Factory__OVM_L1ERC20Gateway: ContractFactory
  before(async () => {
    [alice, bob] = await ethers.getSigners()
    Factory__OVM_L1ERC20Gateway = await ethers.getContractFactory('OVM_L1ERC20Gateway')
  })

  let OVM_L2ERC20Gateway: Contract
  let Mock__OVM_L2CrossDomainMessenger: MockContract
  beforeEach(async () => {
    let l2MessengerImpersonator: Signer
    ;[l2MessengerImpersonator] = await ethers.getSigners()
    Mock__OVM_L2CrossDomainMessenger = await smockit(
      await ethers.getContractFactory('OVM_L2CrossDomainMessenger'),
      { address: await l2MessengerImpersonator.getAddress() } // This allows us to use an ethers override {from: Mock__OVM_L2CrossDomainMessenger.address} to mock calls
    )
    
    OVM_L2ERC20Gateway = await(
      await ethers.getContractFactory('OVM_L2ERC20Gateway')
    ).deploy(
      Mock__OVM_L2CrossDomainMessenger.address,
      'ovmWETH',
      decimals
    )

    await OVM_L2ERC20Gateway.init(MOCK_L1_ERC20_ADDRESS)
  })


  describe('finalizeDeposit', () => {
    it('should revert on calls from a non-crossDomainMessenger L1 account', async () => {
      // Deploy new gateway, initialize with random messenger
      OVM_L2ERC20Gateway = await(
        await ethers.getContractFactory('OVM_L2ERC20Gateway')
      ).deploy(NON_ZERO_ADDRESS, 'ovmWETH', decimals)
      await OVM_L2ERC20Gateway.init(NON_ZERO_ADDRESS)

      await expect(
        OVM_L2ERC20Gateway.finalizeDeposit(ZERO_ADDRESS, 0)
      ).to.be.revertedWith(INVALID_MESSENGER)
    })

    it('should revert on calls from the right crossDomainMessenger, but wrong xDomainMessageSender', async () => {
      Mock__OVM_L2CrossDomainMessenger.smocked.xDomainMessageSender.will.return.with(() => NON_ZERO_ADDRESS)

      await expect(
        OVM_L2ERC20Gateway.finalizeDeposit(
          ZERO_ADDRESS,
          0,
          { from: Mock__OVM_L2CrossDomainMessenger.address }
        )
      ).to.be.revertedWith(INVALID_X_DOMAIN_MSG_SENDER)
    })

    const depositAmount = 100
    it('should credit funds to the depositor', async () => {
      Mock__OVM_L2CrossDomainMessenger.smocked.xDomainMessageSender.will.return.with(() => MOCK_L1_ERC20_ADDRESS)

      await OVM_L2ERC20Gateway.finalizeDeposit(
        await alice.getAddress(),
        depositAmount,
        { from: Mock__OVM_L2CrossDomainMessenger.address }
      )

      const aliceBalance = await OVM_L2ERC20Gateway.balanceOf(await alice.getAddress())
      aliceBalance.should.equal(depositAmount)
    })
  })

  describe('withdrawals', () => {
    const INITIAL_TOTAL_SUPPLY = 100_000
    const ALICE_INITIAL_BALANCE = 50_000
    const withdrawAmount = 1_000
    let SmoddedL2Gateway: ModifiableContract
    beforeEach(async () => {
      // Deploy a smodded gateway so we can give some balances to withdraw
      SmoddedL2Gateway = await (await smoddit('OVM_L2ERC20Gateway', alice)).deploy(
        Mock__OVM_L2CrossDomainMessenger.address,
        'ovmWETH',
        decimals
      )
      await SmoddedL2Gateway.init(
        MOCK_L1_ERC20_ADDRESS
      )

      // Populate the initial state with a total supply and some money in alice's balance
      const aliceAddress = await alice.getAddress()
      SmoddedL2Gateway.smodify.put({
        totalSupply: INITIAL_TOTAL_SUPPLY,
        balances: {
          [aliceAddress] : ALICE_INITIAL_BALANCE
        }
      })
    })

    it('withdraw() burns and sends the correct withdrawal message', async () => { 
      await SmoddedL2Gateway.withdraw(withdrawAmount)
      const withdrawalCallToMessenger = Mock__OVM_L2CrossDomainMessenger.smocked.sendMessage.calls[0]

      // Assert Alice's balance went down
      const aliceBalance = await SmoddedL2Gateway.balanceOf(await alice.getAddress())
      expect(aliceBalance).to.deep.equal(ethers.BigNumber.from(ALICE_INITIAL_BALANCE - withdrawAmount))
      
      // Assert totalSupply went down
      const newTotalSupply = await SmoddedL2Gateway.totalSupply()
      expect(newTotalSupply).to.deep.equal(ethers.BigNumber.from(INITIAL_TOTAL_SUPPLY - withdrawAmount))

      // Assert the correct cross-chain call was sent:
      // Message should be sent to the L1ERC20Gateway on L1
      expect(withdrawalCallToMessenger._target).to.equal(MOCK_L1_ERC20_ADDRESS)
      // Message data should be a call telling the L1ERC20Gateway to finalize the withdrawal
      expect(withdrawalCallToMessenger._message).to.equal(
        await Factory__OVM_L1ERC20Gateway.interface.encodeFunctionData(
          'finalizeWithdrawal',
          [await alice.getAddress(), withdrawAmount]
        )
      )
      // Hardcoded gaslimit should be correct
      expect(withdrawalCallToMessenger._gasLimit).to.equal(HARDCODED_GASLIMIT)
    })

    it('withdraw() burns and sends the correct withdrawal message', async () => { 
      await SmoddedL2Gateway.withdrawTo(await bob.getAddress(), withdrawAmount)
      const withdrawalCallToMessenger = Mock__OVM_L2CrossDomainMessenger.smocked.sendMessage.calls[0]

      // Assert Alice's balance went down
      const aliceBalance = await SmoddedL2Gateway.balanceOf(await alice.getAddress())
      expect(aliceBalance).to.deep.equal(ethers.BigNumber.from(ALICE_INITIAL_BALANCE - withdrawAmount))
      
      // Assert totalSupply went down
      const newTotalSupply = await SmoddedL2Gateway.totalSupply()
      expect(newTotalSupply).to.deep.equal(ethers.BigNumber.from(INITIAL_TOTAL_SUPPLY - withdrawAmount))

      // Assert the correct cross-chain call was sent.
      // Message should be sent to the L1ERC20Gateway on L1
      expect(withdrawalCallToMessenger._target).to.equal(MOCK_L1_ERC20_ADDRESS)
      // The message data should be a call telling the L1ERC20Gateway to finalize the withdrawal
      expect(withdrawalCallToMessenger._message).to.equal(
        await Factory__OVM_L1ERC20Gateway.interface.encodeFunctionData(
          'finalizeWithdrawal',
          [await bob.getAddress(), withdrawAmount]
        )
      )
      // Hardcoded gaslimit should be correct
      expect(withdrawalCallToMessenger._gasLimit).to.equal(HARDCODED_GASLIMIT)
    })
  })

  // low priority todos: see question in contract
  describe.skip('Initialization logic', () => {

    it('should not allow calls to onlyInitialized functions', async () => {
      // TODO
    })

    it('should only allow initialization once and emits initialized event', async () => {
      // TODO
    })
  })
})
