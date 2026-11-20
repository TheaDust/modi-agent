package com.yanimetaxas.bookkeeping.acceptance;

import static io.github.imetaxas.realitycheck.RealityAssertions.assertThat;
import static io.github.imetaxas.realitycheck.RealityAssertions.assertThatThrownBy;

import com.yanimetaxas.bookkeeping.Ledger;
import com.yanimetaxas.bookkeeping.exception.PeriodClosedException;
import org.junit.jupiter.api.Test;

/** Frozen acceptance checks for R2: closing an accounting period. */
class R2AcceptanceTest {

  @Test
  void closedPeriodIsReportedAndListed() {
    Ledger ledger = AcceptanceSupport.ledger("r2-closed", "1000.00");

    ledger.closePeriod(AcceptanceSupport.PERIOD);

    assertThat(ledger.isPeriodClosed(AcceptanceSupport.PERIOD)).isTrue();
    assertThat(ledger.getClosedPeriods()).containsExactly(AcceptanceSupport.PERIOD);
    assertThat(ledger.isPeriodClosed("2026-02")).isFalse();
  }

  @Test
  void transferInTheClosedPeriodIsRejectedAndLeavesBalancesUnchanged() {
    Ledger ledger = AcceptanceSupport.ledger("r2-rejected", "1000.00");
    ledger.closePeriod(AcceptanceSupport.PERIOD);

    assertThatThrownBy(() -> ledger.commit(AcceptanceSupport.payment(ledger, "T1", "50.00")))
        .isInstanceOf(PeriodClosedException.class);

    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "1000.00");
    AcceptanceSupport.assertAmount(ledger.getAccountBalance("REVENUE"), "0.00");
    assertThat(ledger.getTransactionByRef("T1")).isNull();
  }

  @Test
  void transfersSucceedWhileNoPeriodIsClosed() {
    Ledger ledger = AcceptanceSupport.ledger("r2-open", "1000.00");

    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "50.00"));

    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "950.00");
    assertThat(ledger.getClosedPeriods()).isEmpty();
  }

  @Test
  void closingAPeriodDoesNotChangeExistingTransactionsOrBalances() {
    Ledger ledger = AcceptanceSupport.ledger("r2-existing", "1000.00");
    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "50.00"));

    ledger.closePeriod(AcceptanceSupport.PERIOD);

    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "950.00");
    AcceptanceSupport.assertAmount(ledger.getAccountBalance("REVENUE"), "50.00");
    assertThat(ledger.getTransactionByRef("T1")).isNotNull();
  }
}
