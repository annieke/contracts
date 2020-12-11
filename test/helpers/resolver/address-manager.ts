/* External Imports */
import { ethers } from '@nomiclabs/buidler'
import { Contract } from 'ethers'

export const setProxyTarget = async (
  AddressManager: Contract,
  name: string,
  target: Contract
): Promise<void> => {
  const SimpleProxy: Contract = await (
    await ethers.getContractFactory('Helper_SimpleProxy')
  ).deploy()

  await SimpleProxy.setTarget(target.address)
  await AddressManager.setAddress(name, SimpleProxy.address)
}

export const makeAddressManager = async (): Promise<Contract> => {
  return (await ethers.getContractFactory('OVM_AddressManager')).deploy()
}
