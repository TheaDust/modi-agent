/*
 * Copyright 2019 fahmpeermoh
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

package com.cronutils.converter;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.time.ZoneId;
import java.util.Calendar;
import java.util.GregorianCalendar;
import java.util.TimeZone;
import java.util.stream.Stream;
import org.mockito.MockedStatic;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.mockStatic;
import static org.mockito.Mockito.CALLS_REAL_METHODS;
import static org.mockito.ArgumentMatchers.any;

public class CronConverterTest {
	private CronConverter cronConverter = spy(new CronConverter(
			new CronToCalendarTransformer(),
			new CalendarToCronTransformer()
	));

	public static Stream<Arguments> cronExpressions() {
		return Stream.of(Arguments.of("Pacific/Pago_Pago", "15 * * * *", "15 * * * *"),
				Arguments.of("Antarctica/Casey", "? * * * *", "? * * * *"),
				Arguments.of("Antarctica/Troll", "45 * * * *", "45 * * * *"),
				Arguments.of("Pacific/Chatham", "15 * * * *", "30 * * * *"),
				Arguments.of("Asia/Colombo", "45 * * ? *", "15 * * ? *"),
				Arguments.of("Asia/Colombo", "0/45 * * ? *", "0/45 * * ? *"),
				Arguments.of("Australia/Eucla", "13 * * ? *", "28 * * ? *"),
				Arguments.of("America/St_Johns", "0 0/15 * * * ?", "30 0/15 * * * ?"),
				Arguments.of("America/St_Johns", "0 8 * * ?", "30 10 * * ?"),
				Arguments.of("America/St_Johns", "0 0/1 * * ?", "30 0/1 * * ?"),
				Arguments.of("America/St_Johns", "20 0 * * ?", "50 2 * * ?"),
				Arguments.of("Asia/Kolkata", "20 0 * * ?", "50 18 * * ?")
		);
	}

	@ParameterizedTest
	@MethodSource("cronExpressions")
	public void testCronConverterBuilder(String timezone, String inputCronExpression, String expectedCronExpression) {
		try (MockedStatic<Calendar> calendars = mockStatic(Calendar.class, CALLS_REAL_METHODS)) {
			calendars.when(() -> Calendar.getInstance(any(TimeZone.class))).thenAnswer(invocation -> {
				Calendar calendar = new GregorianCalendar(invocation.getArgument(0, TimeZone.class));
				calendar.clear();
				calendar.set(2020, Calendar.JULY, 1, 12, 0, 0);
				return calendar;
			});
		assertEquals(expectedCronExpression,
				cronConverter.using(inputCronExpression)
						.from(ZoneId.of(timezone)).to(ZoneId.of("UTC"))
						.convert());
		}
	}
}
