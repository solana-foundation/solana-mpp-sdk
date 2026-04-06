local t = require('tests.test_helper')
local verify = require('mpp.server.solana_verify')
local mpp = require('mpp')

local function signature_context(overrides)
  local base = {
    payload = {
      type = 'signature',
      signature = 'sig-123',
    },
    request = {
      amount = '1000',
      currency = 'sol',
      recipient = 'recipient-1',
      methodDetails = {},
    },
    method_details = {},
  }
  for key, value in pairs(overrides or {}) do
    base[key] = value
  end
  return base
end

t.test('signature verifier succeeds for native SOL transfer', function()
  local result = verify.verify_signature(signature_context(), {
    fetch_transaction = function(signature)
      t.assert_equal(signature, 'sig-123')
      return {
        meta = { err = nil },
        transaction = {
          message = {
            instructions = {
              {
                program = 'system',
                parsed = {
                  type = 'transfer',
                  info = {
                    destination = 'recipient-1',
                    lamports = '1000',
                  },
                },
              },
            },
          },
        },
      }
    end,
  })
  t.assert_equal(result.reference, 'sig-123')
end)

t.test('transaction verifier broadcasts and verifies confirmed transfer', function()
  local sent = nil
  local result = verify.verify_transaction({
    payload = {
      type = 'transaction',
      transaction = 'base64-tx',
    },
    request = {
      amount = '1000',
      currency = 'sol',
      recipient = 'recipient-1',
      methodDetails = {},
    },
    method_details = {},
  }, {
    send_transaction = function(transaction)
      sent = transaction
      return 'sig-456'
    end,
    await_transaction = function(signature)
      t.assert_equal(signature, 'sig-456')
      return {
        meta = { err = nil },
        transaction = {
          message = {
            instructions = {
              {
                program = 'system',
                parsed = {
                  type = 'transfer',
                  info = {
                    destination = 'recipient-1',
                    lamports = '1000',
                  },
                },
              },
            },
          },
        },
      }
    end,
  })
  t.assert_equal(sent, 'base64-tx')
  t.assert_equal(result.reference, 'sig-456')
end)

t.test('signature verifier succeeds for SPL transfer using token account lookup', function()
  local context = signature_context({
    request = {
      amount = '2500',
      currency = 'mint-1',
      recipient = 'recipient-1',
      methodDetails = {
        tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      },
    },
    method_details = {
      tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    },
  })

  local result = verify.verify_signature(context, {
    fetch_transaction = function()
      return {
        meta = { err = nil },
        transaction = {
          message = {
            instructions = {
              {
                programId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                parsed = {
                  type = 'transferChecked',
                  info = {
                    destination = 'token-account-1',
                    mint = 'mint-1',
                    tokenAmount = { amount = '2500' },
                  },
                },
              },
            },
          },
        },
      }
    end,
    fetch_token_account = function(address)
      t.assert_equal(address, 'token-account-1')
      return {
        owner = 'recipient-1',
        mint = 'mint-1',
      }
    end,
  })
  t.assert_equal(result.reference, 'sig-123')
end)

t.test('signature verifier resolves USDC alias for localnet', function()
  local context = signature_context({
    request = {
      amount = '2500',
      currency = 'USDC',
      recipient = 'recipient-1',
      methodDetails = {
        network = 'localnet',
        tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      },
    },
    method_details = {
      network = 'localnet',
      tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    },
  })

  local result = verify.verify_signature(context, {
    fetch_transaction = function()
      return {
        meta = { err = nil },
        transaction = {
          message = {
            instructions = {
              {
                programId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                parsed = {
                  type = 'transferChecked',
                  info = {
                    destination = 'token-account-1',
                    mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                    tokenAmount = { amount = '2500' },
                  },
                },
              },
            },
          },
        },
      }
    end,
    fetch_token_account = function(address)
      t.assert_equal(address, 'token-account-1')
      return {
        owner = 'recipient-1',
        mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      }
    end,
  })
  t.assert_equal(result.reference, 'sig-123')
end)

t.test('signature verifier supports split transfers', function()
  local context = signature_context({
    request = {
      amount = '1000',
      currency = 'sol',
      recipient = 'recipient-1',
      methodDetails = {
        splits = {
          { recipient = 'recipient-2', amount = '200' },
          { recipient = 'recipient-3', amount = '100' },
        },
      },
    },
    method_details = {
      splits = {
        { recipient = 'recipient-2', amount = '200' },
        { recipient = 'recipient-3', amount = '100' },
      },
    },
  })
  local result = verify.verify_signature(context, {
    fetch_transaction = function()
      return {
        meta = { err = nil },
        transaction = {
          message = {
            instructions = {
              { program = 'system', parsed = { type = 'transfer', info = { destination = 'recipient-1', lamports = '700' } } },
              { program = 'system', parsed = { type = 'transfer', info = { destination = 'recipient-2', lamports = '200' } } },
              { program = 'system', parsed = { type = 'transfer', info = { destination = 'recipient-3', lamports = '100' } } },
            },
          },
        },
      }
    end,
  })
  t.assert_equal(result.reference, 'sig-123')
end)

t.test('signature verifier rejects missing signature', function()
  t.assert_error(function()
    verify.verify_signature(signature_context({
      payload = { type = 'signature' },
    }), {
      fetch_transaction = function()
        return nil
      end,
    })
  end, 'missing signature')
end)

t.test('transaction verifier rejects missing transaction payload', function()
  t.assert_error(function()
    verify.verify_transaction({
      payload = { type = 'transaction' },
      request = {
        amount = '1000',
        currency = 'sol',
        recipient = 'recipient-1',
        methodDetails = {},
      },
      method_details = {},
    }, {
      send_transaction = function()
        return 'sig-123'
      end,
      await_transaction = function()
        return nil
      end,
    })
  end, 'missing transaction')
end)

t.test('signature verifier rejects missing transaction result', function()
  t.assert_error(function()
    verify.verify_signature(signature_context(), {
      fetch_transaction = function()
        return nil
      end,
    })
  end, 'transaction not found')
end)

t.test('signature verifier rejects failed transactions', function()
  t.assert_error(function()
    verify.verify_signature(signature_context(), {
      fetch_transaction = function()
        return {
          meta = { err = { InstructionError = { 0, 'Custom' } } },
          transaction = { message = { instructions = {} } },
        }
      end,
    })
  end, 'transaction failed on%-chain')
end)

t.test('signature verifier rejects missing SOL transfer', function()
  t.assert_error(function()
    verify.verify_signature(signature_context(), {
      fetch_transaction = function()
        return {
          meta = { err = nil },
          transaction = { message = { instructions = {} } },
        }
      end,
    })
  end, 'no matching SOL transfer')
end)

t.test('signature verifier rejects missing token account callback', function()
  t.assert_error(function()
    verify.verify_signature(signature_context({
      request = {
        amount = '1000',
        currency = 'mint-1',
        recipient = 'recipient-1',
        methodDetails = {},
      },
      method_details = {},
    }), {
      fetch_transaction = function()
        return {
          meta = { err = nil },
          transaction = { message = { instructions = {} } },
        }
      end,
    })
  end, 'fetch_token_account callback is required')
end)

t.test('signature verifier rejects unmatched token owner', function()
  t.assert_error(function()
    verify.verify_signature(signature_context({
      request = {
        amount = '2500',
        currency = 'mint-1',
        recipient = 'recipient-1',
        methodDetails = {
          tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        },
      },
      method_details = {
        tokenProgram = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      },
    }), {
      fetch_transaction = function()
        return {
          meta = { err = nil },
          transaction = {
            message = {
              instructions = {
                {
                  programId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
                  parsed = {
                    type = 'transferChecked',
                    info = {
                      destination = 'token-account-1',
                      mint = 'mint-1',
                      tokenAmount = { amount = '2500' },
                    },
                  },
                },
              },
            },
          },
        }
      end,
      fetch_token_account = function()
        return {
          owner = 'wrong-owner',
          mint = 'mint-1',
        }
      end,
    })
  end, 'no matching token transfer')
end)

t.test('signature verifier handles transaction payload mode through pull verification', function()
  local verifier = verify.new_signature_verifier({
    send_transaction = function(transaction)
      t.assert_equal(transaction, 'deadbeef')
      return 'sig-pull'
    end,
    await_transaction = function(signature)
      t.assert_equal(signature, 'sig-pull')
      return {
        meta = { err = nil },
        transaction = {
          message = {
            instructions = {
              {
                program = 'system',
                parsed = {
                  type = 'transfer',
                  info = {
                    destination = 'recipient-1',
                    lamports = '1000',
                  },
                },
              },
            },
          },
        },
      }
    end,
  })
  local result = verifier(signature_context({
    payload = {
      type = 'transaction',
      transaction = 'deadbeef',
    },
  }))
  t.assert_equal(result.reference, 'sig-pull')
end)

t.test('server can wire verifier hooks automatically', function()
  local server = mpp.server.new({
    recipient = 'recipient-1',
    currency = 'sol',
    decimals = 9,
    network = 'localnet',
    secret_key = 'test-secret',
    verifier_hooks = {
      fetch_transaction = function(signature)
        t.assert_equal(signature, 'sig-123')
        return {
          meta = { err = nil },
          transaction = {
            message = {
              instructions = {
                {
                  program = 'system',
                  parsed = {
                    type = 'transfer',
                    info = {
                      destination = 'recipient-1',
                      lamports = '1',
                    },
                  },
                },
              },
            },
          },
        }
      end,
    },
  })
  local challenge = server:charge('0.000000001')
  local credential = mpp.NewPaymentCredential(challenge:to_echo(), {
    type = 'signature',
    signature = 'sig-123',
  })
  local receipt = server:verify_credential(credential, 1770000000)
  t.assert_equal(receipt.reference, 'sig-123')
end)
