package com.yanimetaxas.bookkeeping.acceptance;

import static io.github.imetaxas.realitycheck.RealityAssertions.assertThat;
import static io.github.imetaxas.realitycheck.RealityAssertions.assertThatThrownBy;

import com.yanimetaxas.bookkeeping.ChartOfAccounts;
import com.yanimetaxas.bookkeeping.ChartOfAccounts.ChartOfAccountsBuilder;
import com.yanimetaxas.bookkeeping.Ledger;
import com.yanimetaxas.bookkeeping.Ledger.LedgerBuilder;
import com.yanimetaxas.bookkeeping.exception.TransferLimitExceededException;
import com.yanimetaxas.bookkeeping.model.AccountSide;
import com.yanimetaxas.bookkeeping.model.Money;
import org.junit.jupiter.api.Test;

/** Frozen acceptance checks for R1: a per-transfer debit limit on an account. */
class R1AcceptanceTest {

  private static Ledger limitedLedger(String name) {
    ChartOfAccounts chart =
        new ChartOfAccountsBuilder()
            .create(
                "CASH",
                "1000.00",
                "EUR",
                AccountSide.DEBIT,
                Money.toMoney("100.00", "EUR"))
            .create("REVENUE", "0.00", "EUR")
            .build();
    return new LedgerBuilder(chart).name(name).clock(AcceptanceSupport.CLOCK).build().init();
  }

  @Test
  void transferBelowTheLimitIsAccepted() {
    Ledger ledger = limitedLedger("r1-below");

    ledger.commit(AcceptanceSupport.debitFrom(ledger, "T1", "CASH", "REVENUE", "50.00"));

    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "950.00");
    assertThat(ledger.getTransactionByRef("T1")).isNotNull();
  }

  @Test
  void transferEqualToTheLimitIsAccepted() {
    Ledger ledger = limitedLedger("r1-equal");

    ledger.commit(AcceptanceSupport.debitFrom(ledger, "T1", "CASH", "REVENUE", "100.00"));

    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "900.00");
  }

  @Test
  void transferAboveTheLimitIsRejectedAndLeavesBalancesUnchanged() {
    Ledger ledger = limitedLedger("r1-above");

    assertThatThrownBy(
            () ->
                ledger.commit(
                    AcceptanceSupport.debitFrom(ledger, "T1", "CASH", "REVENUE", "150.00")))
        .isInstanceOf(TransferLimitExceededException.class);

    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "1000.00");
    AcceptanceSupport.assertAmount(ledger.getAccountBalance("REVENUE"), "0.00");
    assertThat(ledger.getTransactionByRef("T1")).isNull();
  }

  @Test
  void debitLegsOfOneTransferAreSummedPerAccount() {
    Ledger ledger = limitedLedger("r1-summed");

    assertThatThrownBy(
            () ->
                ledger.commit(
                    ledger
                        .createTransferRequest()
                        .reference("T1")
                        .type("payout")
                        .account("CASH")
                        .debit("50.00", "EUR")
                        .account("CASH")
                        .debit("60.00", "EUR")
                        .account("REVENUE")
                        .credit("110.00", "EUR")
                        .build()))
        .isInstanceOf(TransferLimitExceededException.class);

    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "1000.00");
    assertThat(ledger.getTransactionByRef("T1")).isNull();
  }

  @Test
  void theLimitIsReadableAndAbsentAccountsHaveNoLimit() {
    Ledger ledger = limitedLedger("r1-readable");

    AcceptanceSupport.assertAmount(ledger.accountService().getTransferLimit("CASH"), "100.00");
    assertThat(ledger.accountService().getTransferLimit("REVENUE")).isNull();
  }

  @Test
  void anAccountCreatedWithALimitKeepsIt() {
    Ledger ledger = AcceptanceSupport.ledger("r1-created", "1000.00");

    ledger
        .accountService()
        .createAccount(
            "NEW", Money.toMoney("500.00", "EUR"), AccountSide.DEBIT, Money.toMoney("25.00", "EUR"));

    AcceptanceSupport.assertAmount(ledger.accountService().getTransferLimit("NEW"), "25.00");
    assertThat(ledger.accountService().getTransferLimit("CASH")).isNull();
  }

  @Test
  void accountsWithoutALimitAcceptAnyAmount() {
    Ledger ledger = AcceptanceSupport.ledger("r1-no-limit", "1000.00");

    ledger.commit(AcceptanceSupport.debitFrom(ledger, "T1", "CASH", "REVENUE", "900.00"));

    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "100.00");
  }
}
